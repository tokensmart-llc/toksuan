import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { LruTtlCache } from "./lru-ttl-cache";

/**
 * AES-256-GCM helpers used by the BYO upstream-provider-key feature.
 *
 * Master key comes from `TOKENSMART_PROVIDER_KEY_ENCRYPTION` and must decode
 * to exactly 32 bytes. Accept either:
 *   - 64 hex chars (`openssl rand -hex 32`)
 *   - 44-char base64 of 32 bytes (`openssl rand -base64 32`)
 *
 * Wire format: base64( IV(12B) || ciphertext || GCM-tag(16B) ).
 *
 * IMPORTANT: rotating the master key invalidates every existing
 * `user_provider_keys.encrypted_key`. There's no graceful re-key flow yet —
 * users would have to re-paste their provider keys. Document loudly when we
 * ship the marketing site.
 */

import { createHash } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Parse a 32-byte master key from a hex or base64 string. Used both by the
 * lazy env loader below and by the rotation script (which needs to hold two
 * keys side-by-side and can't rely on the cached singleton).
 */
export function parseEncryptionKey(raw: string, label = "key"): Buffer {
  const trimmed = raw.trim();
  let buf: Buffer;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_LEN * 2) {
    buf = Buffer.from(trimmed, "hex");
  } else {
    try {
      buf = Buffer.from(trimmed, "base64");
    } catch {
      throw new Error(`${label} must be 64 hex chars or base64 of 32 bytes`);
    }
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `${label} must decode to exactly ${KEY_LEN} bytes (got ${buf.length}); generate with \`openssl rand -hex 32\``
    );
  }
  return buf;
}

/**
 * AES-256-GCM encrypt with an explicit key. Wire format:
 *   base64( IV(12B) || ciphertext || GCM-tag(16B) ).
 */
export function encryptWith(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new Error(`key must be ${KEY_LEN} bytes (got ${key.length})`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/**
 * AES-256-GCM decrypt with an explicit key. Throws if the key is wrong (the
 * GCM auth tag won't verify), if the blob is malformed, or if the tag fails
 * to authenticate. Callers in rotation flows lean on these throws to detect
 * "this row was encrypted with a different key" without false positives.
 */
export function decryptWith(blob: string, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new Error(`key must be ${KEY_LEN} bytes (got ${key.length})`);
  }
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("encrypted blob too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Stable, non-secret short identifier of a master key. Useful for ops logs
 * + audit metadata so an operator can verify "we rotated from key XXXX to
 * key YYYY" without ever exposing the key bytes themselves. First 8 hex
 * chars of SHA-256(key).
 */
export function masterKeyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// =========================================================================
// ProviderKeyProvider — pluggable backend for the master encryption key
// =========================================================================
//
// All BYO-key encrypt / decrypt go through this interface. The single
// implementation today (`EnvKeyProvider`) wraps the AES-256-GCM helpers
// above with a master key loaded from `TOKENSMART_PROVIDER_KEY_ENCRYPTION`.
//
// To add a KMS backend later (AWS KMS, GCP KMS, HashiCorp Vault Transit):
//
//   1. Implement a new `KmsKeyProvider` class against this interface.
//   2. Inside `encryptCurrent`: generate a random 256-bit DEK, use it to
//      AES-GCM encrypt the plaintext, ask KMS to wrap the DEK with the
//      configured CMK, return `{ ciphertext: encryptedDek||iv||ct||tag,
//      fingerprint: <kms-key-version-arn> }`.
//   3. Inside `decrypt`: split off the wrapped DEK, ask KMS to unwrap it,
//      use it to AES-GCM decrypt the rest. Match `fingerprint` against the
//      KMS key version when present.
//   4. Wire it into `getKeyProvider()` below behind a new env var like
//      `TOKENSMART_KMS_KEY_ARN`.
//
// The rest of TokenSmart treats `fingerprint` as opaque — for env-backed
// it's `sha256(masterKey)[:8]`, for KMS it would be the key-version ARN.
// `user_provider_keys.master_key_fingerprint` stores whatever the provider
// gave us; rotation uses it to filter rows efficiently regardless of
// backend.

export interface ProviderKeyProvider {
  /** Stable provider identifier. `"env"` or `"kms"`. */
  readonly name: "env" | "kms";

  /** True when the provider is fully configured. False = provider unavailable. */
  isConfigured(): boolean;

  /** Stable, non-secret short identifier of the currently-active key. */
  currentFingerprint(): string;

  /**
   * True if this provider is the one that wrote a row stamped with this
   * fingerprint. Used by the dispatcher to pick the right backend when
   * reading legacy rows during a cross-provider migration. EnvKeyProvider
   * accepts hex-only fingerprints; KmsKeyProvider accepts `kms:*` prefixed
   * ones.
   */
  canHandle(fingerprint: string): boolean;

  /**
   * Encrypt with the currently-active key. Always tags the returned object
   * with the fingerprint so the caller can persist it alongside the
   * ciphertext for efficient lookup later.
   */
  encryptCurrent(
    plaintext: string
  ): Promise<{ ciphertext: string; fingerprint: string }>;

  /**
   * Decrypt the blob.
   *
   * @param fingerprint - When provided, the provider MUST decrypt with the
   *   key that has this fingerprint and reject mismatches. When NULL (legacy
   *   rows from before the fingerprint column existed), the provider falls
   *   back to trying the current key.
   */
  decrypt(ciphertext: string, fingerprint: string | null): Promise<string>;
}

// =========================================================================
// Envelope wire format (used by KmsKeyProvider)
// =========================================================================
//
//   [ magic(1B) ][ dek_len(2B BE) ][ wrapped_dek ][ iv(12B) ][ ct(N) ][ tag(16B) ]
//
// Whole thing base64-encoded on disk. The magic byte is there so we can
// evolve the format (v2 might change the wrapped-DEK layout, use a different
// AEAD, etc.) without needing a DB migration to identify old rows — new
// magic = new code path. Today the only magic value is 0x01.

const ENVELOPE_MAGIC_V1 = 0x01;
const ENVELOPE_DEK_LEN_BYTES = 2;

export function packEnvelope(
  wrappedDek: Buffer,
  iv: Buffer,
  ciphertextWithTag: Buffer
): string {
  if (wrappedDek.length > 0xffff) {
    throw new Error(
      `wrapped DEK too large (${wrappedDek.length} bytes); max ${0xffff}`
    );
  }
  const header = Buffer.alloc(1 + ENVELOPE_DEK_LEN_BYTES);
  header.writeUInt8(ENVELOPE_MAGIC_V1, 0);
  header.writeUInt16BE(wrappedDek.length, 1);
  return Buffer.concat([
    header,
    wrappedDek,
    iv,
    ciphertextWithTag,
  ]).toString("base64");
}

export type UnpackedEnvelope = {
  wrappedDek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

export function unpackEnvelope(blob: string): UnpackedEnvelope {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < 1 + ENVELOPE_DEK_LEN_BYTES + IV_LEN + TAG_LEN) {
    throw new Error("envelope blob too short to be well-formed");
  }
  const magic = buf.readUInt8(0);
  if (magic !== ENVELOPE_MAGIC_V1) {
    throw new Error(
      `unknown envelope magic 0x${magic.toString(16)}; this build expects 0x01`
    );
  }
  const dekLen = buf.readUInt16BE(1);
  const headerLen = 1 + ENVELOPE_DEK_LEN_BYTES;
  if (buf.length < headerLen + dekLen + IV_LEN + TAG_LEN) {
    throw new Error("envelope blob truncated");
  }
  const wrappedDek = buf.subarray(headerLen, headerLen + dekLen);
  const ivStart = headerLen + dekLen;
  const iv = buf.subarray(ivStart, ivStart + IV_LEN);
  const ctStart = ivStart + IV_LEN;
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(ctStart, buf.length - TAG_LEN);
  return { wrappedDek, iv, ciphertext, tag };
}

/**
 * AES-256-GCM encrypt with an explicit DEK. Used by KmsKeyProvider after
 * it's generated a fresh DEK. Returns { iv, ciphertextWithTag } so the
 * caller can pack them into an envelope blob.
 */
export function aesGcmEncrypt(
  plaintext: string,
  dek: Buffer
): { iv: Buffer; ciphertextWithTag: Buffer } {
  if (dek.length !== KEY_LEN) {
    throw new Error(`DEK must be ${KEY_LEN} bytes (got ${dek.length})`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertextWithTag: Buffer.concat([ct, tag]) };
}

/**
 * AES-256-GCM decrypt with an explicit DEK. Used by KmsKeyProvider after
 * it's unwrapped the DEK via KMS.
 */
export function aesGcmDecrypt(
  ciphertext: Buffer,
  tag: Buffer,
  iv: Buffer,
  dek: Buffer
): string {
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}

export class EnvKeyProvider implements ProviderKeyProvider {
  readonly name = "env" as const;
  private cached: Buffer | null | undefined;

  private load(): Buffer | null {
    if (this.cached !== undefined) return this.cached;
    const raw = process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION?.trim();
    if (!raw) {
      this.cached = null;
      return null;
    }
    this.cached = parseEncryptionKey(
      raw,
      "TOKENSMART_PROVIDER_KEY_ENCRYPTION"
    );
    return this.cached;
  }

  isConfigured(): boolean {
    return this.load() != null;
  }

  currentFingerprint(): string {
    const key = this.load();
    if (!key) {
      throw new Error(
        "TOKENSMART_PROVIDER_KEY_ENCRYPTION is not set; cannot derive fingerprint"
      );
    }
    return masterKeyFingerprint(key);
  }

  canHandle(fingerprint: string): boolean {
    // Env fingerprints are 8 hex chars. KMS fingerprints start with `kms:`
    // and are unambiguous. Anything that looks like `kms:*` is NOT ours.
    return /^[0-9a-f]{8}$/.test(fingerprint);
  }

  async encryptCurrent(
    plaintext: string
  ): Promise<{ ciphertext: string; fingerprint: string }> {
    const key = this.load();
    if (!key) {
      throw new Error(
        "TOKENSMART_PROVIDER_KEY_ENCRYPTION is not set; cannot encrypt BYO provider keys"
      );
    }
    return {
      ciphertext: encryptWith(plaintext, key),
      fingerprint: masterKeyFingerprint(key),
    };
  }

  async decrypt(
    blob: string,
    fingerprint: string | null
  ): Promise<string> {
    const key = this.load();
    if (!key) {
      throw new Error(
        "TOKENSMART_PROVIDER_KEY_ENCRYPTION is not set; cannot decrypt BYO provider keys"
      );
    }
    if (fingerprint != null && fingerprint !== masterKeyFingerprint(key)) {
      throw new Error(
        `master key mismatch: row encrypted with fingerprint ${fingerprint}, ` +
          `current env key is ${masterKeyFingerprint(key)}. ` +
          `Run \`bun run rotate-master-key\` to migrate, or restore the original key in env.`
      );
    }
    return decryptWith(blob, key);
  }

  /** Reset the cached master key. Tests + rotation script only. */
  _reset(): void {
    this.cached = undefined;
  }
}

// =========================================================================
// Registry — picks the right backend for read vs write
// =========================================================================
//
// Both providers can coexist so a hosted operator can migrate env → KMS
// without a hard cutover: after the KMS env vars are set, new writes go to
// KMS while old env-encrypted rows are still readable via EnvKeyProvider.
// The `migrate-to-kms.ts` script sweeps the old rows onto KMS on your
// schedule.
//
//   getActiveKeyProvider()       – chosen backend for new encrypts
//   getProviderForDecrypt(fp)    – backend that matches the stored fingerprint
//   getKeyProvider()             – legacy alias for getActiveKeyProvider()

const envKeyProvider = new EnvKeyProvider();

// Deliberately deferred. The SDKs for AWS KMS and GCP KMS are each ~200KB+
// gzipped. We only want to pay that cost when the operator actually
// configured that backend. `initProviderRegistry()` is called from the
// gateway entrypoint at boot; after that all getters below are sync.
//
// In environments where async boot init isn't practical (Next.js server
// components, which the dashboard uses), the dashboard's parallel
// lib/crypto.ts takes a slightly different approach — it lazy-imports
// SDKs inside the first encrypt call. Slower first call, zero boot work.
let initialized = false;
let activeProvider: ProviderKeyProvider = envKeyProvider;
const providersByFingerprintPrefix: Array<{
  prefix: string | null; // null means "any hex" (env) — handled by predicate
  provider: ProviderKeyProvider;
}> = [];

type InitFlags = {
  env: boolean;
  aws: boolean;
  gcp: boolean;
};

function describeActiveBackends(): InitFlags {
  return {
    env: envKeyProvider.isConfigured(),
    aws: !!process.env.TOKENSMART_KMS_KEY_ARN,
    gcp: !!process.env.TOKENSMART_GCP_KMS_KEY_NAME,
  };
}

/**
 * Async one-shot registry init. Dynamic imports happen here so a gateway
 * with only env-crypto configured never loads the AWS / GCP SDKs at all —
 * that's a ~1 MB bundle / boot-time win when those features aren't in use.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 *
 * Throws at startup if the operator set both `TOKENSMART_KMS_KEY_ARN` AND
 * `TOKENSMART_GCP_KMS_KEY_NAME` — that config is ambiguous (which one
 * writes new rows?) and we'd rather fail loud than pick one silently.
 */
export async function initProviderRegistry(): Promise<void> {
  if (initialized) return;
  initialized = true;
  providersByFingerprintPrefix.length = 0;

  const flags = describeActiveBackends();

  if (flags.aws && flags.gcp) {
    throw new Error(
      "Cannot configure BOTH TOKENSMART_KMS_KEY_ARN and TOKENSMART_GCP_KMS_KEY_NAME. Pick one backend for new writes."
    );
  }

  // AWS
  if (flags.aws) {
    const { KmsKeyProvider } = await import("./kms-provider");
    const raw = new KmsKeyProvider({
      keyArn: process.env.TOKENSMART_KMS_KEY_ARN!,
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
      endpoint: process.env.TOKENSMART_KMS_ENDPOINT_URL,
    });
    const cached = wrapWithCacheIfBeneficial(raw);
    providersByFingerprintPrefix.push({ prefix: "kms:", provider: cached });
    activeProvider = cached;
  }

  // GCP
  if (flags.gcp) {
    const { GcpKmsKeyProvider } = await import("./gcp-kms-provider");
    const raw = new GcpKmsKeyProvider({
      keyName: process.env.TOKENSMART_GCP_KMS_KEY_NAME!,
    });
    const cached = wrapWithCacheIfBeneficial(raw);
    providersByFingerprintPrefix.push({ prefix: "gcp:", provider: cached });
    activeProvider = cached;
  }

  // Env is always registered last (so it's the fallback for NULL rows).
  // It stays the active provider only if no KMS backend is configured.
  providersByFingerprintPrefix.push({
    prefix: null,
    provider: envKeyProvider,
  });
  if (!flags.aws && !flags.gcp) {
    activeProvider = envKeyProvider;
  }
}

/**
 * Synchronous safety net for paths that might run before `init` completes
 * (e.g. a worker that imports this module before the entrypoint's await).
 * Forces init using `require()` semantics if needed. Use sparingly.
 */
function ensureInitializedSync(): void {
  if (initialized) return;
  initialized = true;
  providersByFingerprintPrefix.length = 0;

  const flags = describeActiveBackends();
  if (flags.aws && flags.gcp) {
    throw new Error(
      "Cannot configure BOTH TOKENSMART_KMS_KEY_ARN and TOKENSMART_GCP_KMS_KEY_NAME. Pick one backend for new writes."
    );
  }

  // Use require() here because we can't await. This pulls the SDK in — the
  // async-init path above is preferred and avoids this.
  if (flags.aws) {
    const { KmsKeyProvider } = require("./kms-provider") as typeof import("./kms-provider");
    const raw = new KmsKeyProvider({
      keyArn: process.env.TOKENSMART_KMS_KEY_ARN!,
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
      endpoint: process.env.TOKENSMART_KMS_ENDPOINT_URL,
    });
    const cached = wrapWithCacheIfBeneficial(raw);
    providersByFingerprintPrefix.push({ prefix: "kms:", provider: cached });
    activeProvider = cached;
  }
  if (flags.gcp) {
    const { GcpKmsKeyProvider } = require("./gcp-kms-provider") as typeof import("./gcp-kms-provider");
    const raw = new GcpKmsKeyProvider({
      keyName: process.env.TOKENSMART_GCP_KMS_KEY_NAME!,
    });
    const cached = wrapWithCacheIfBeneficial(raw);
    providersByFingerprintPrefix.push({ prefix: "gcp:", provider: cached });
    activeProvider = cached;
  }
  providersByFingerprintPrefix.push({
    prefix: null,
    provider: envKeyProvider,
  });
  if (!flags.aws && !flags.gcp) {
    activeProvider = envKeyProvider;
  }
}

export function getActiveKeyProvider(): ProviderKeyProvider {
  if (!initialized) ensureInitializedSync();
  return activeProvider;
}

export function getProviderForDecrypt(
  fingerprint: string | null
): ProviderKeyProvider {
  if (!initialized) ensureInitializedSync();

  if (fingerprint == null) {
    // Legacy NULL row — predates the fingerprint column, so by definition
    // predates KMS too. Always env-era.
    if (!envKeyProvider.isConfigured()) {
      throw new Error(
        "legacy NULL-fingerprint row but env provider not configured; run migrate-to-kms first, or restore TOKENSMART_PROVIDER_KEY_ENCRYPTION"
      );
    }
    return envKeyProvider;
  }

  // Walk the prefix-keyed handlers. Env provider's canHandle() checks the
  // hex-only shape explicitly, so ordering within the array doesn't matter.
  for (const entry of providersByFingerprintPrefix) {
    if (entry.provider.canHandle(fingerprint)) {
      if (!entry.provider.isConfigured()) {
        const hint =
          entry.prefix === "kms:"
            ? "set TOKENSMART_KMS_KEY_ARN"
            : entry.prefix === "gcp:"
              ? "set TOKENSMART_GCP_KMS_KEY_NAME"
              : "set TOKENSMART_PROVIDER_KEY_ENCRYPTION";
        throw new Error(
          `row encrypted with fingerprint ${fingerprint} but corresponding provider not configured; ${hint}`
        );
      }
      return entry.provider;
    }
  }
  throw new Error(`no provider claims fingerprint ${fingerprint}`);
}

/** @deprecated kept as an alias for the write-side provider. */
export function getKeyProvider(): ProviderKeyProvider {
  return getActiveKeyProvider();
}

// --- Backward-compat sugar around the active provider --------------------

export function isProviderKeyEncryptionConfigured(): boolean {
  return getActiveKeyProvider().isConfigured();
}

export async function encryptProviderKey(
  plaintext: string
): Promise<{ ciphertext: string; fingerprint: string }> {
  return getActiveKeyProvider().encryptCurrent(plaintext);
}

export async function decryptProviderKey(
  blob: string,
  fingerprint: string | null = null
): Promise<string> {
  return getProviderForDecrypt(fingerprint).decrypt(blob, fingerprint);
}

/** Reset all cached state. Tests only. */
export function _resetCryptoForTests(): void {
  envKeyProvider._reset();
  initialized = false;
  activeProvider = envKeyProvider;
  providersByFingerprintPrefix.length = 0;
}

export { envKeyProvider as _envKeyProviderForTests };

// =========================================================================
// Decryption caching
// =========================================================================
//
// The env-backed provider does AES-GCM in CPU-local time (~microseconds) so
// caching buys nothing there. KMS-backed providers do a round-trip per read
// (~5-20ms + QPS quota). `CachingKeyProvider` wraps any ProviderKeyProvider
// and memoizes `decrypt(envelope)` → plaintext so a tight agent loop
// against the same BYO key hits the network once per TTL window instead of
// every request.
//
// Cache key: `sha256(ciphertext).slice(0, 32)`. Collision-resistant, stable
// per row content, never exposes the ciphertext itself in memory. Value:
// the decrypted plaintext (i.e. the customer's raw OpenAI/Anthropic key) —
// same threat profile as the in-flight decrypted value, just held for
// longer. Operators who treat RAM as untrusted can set TTL=0 to disable.

export type CacheOptions = {
  /** 0 disables. Default 10 min. */
  ttlMs: number;
  /** 0 disables. Default 1000. */
  maxSize: number;
};

function hashForCache(blob: string): string {
  // Reuse createHash via the top-level import below. Deliberately only the
  // first 32 hex chars so the key stays short. 16 bytes of hash is
  // overkill for collision resistance here (the cache is tiny).
  const h = createHash("sha256").update(blob).digest("hex");
  return h.slice(0, 32);
}

export class CachingKeyProvider implements ProviderKeyProvider {
  readonly name: ProviderKeyProvider["name"];
  private readonly cache: LruTtlCache<string>;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: ProviderKeyProvider,
    opts: CacheOptions
  ) {
    this.name = inner.name;
    this.cache = new LruTtlCache<string>(opts.maxSize, opts.ttlMs);
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }
  currentFingerprint(): string {
    return this.inner.currentFingerprint();
  }
  canHandle(fp: string): boolean {
    return this.inner.canHandle(fp);
  }

  async encryptCurrent(
    plaintext: string
  ): Promise<{ ciphertext: string; fingerprint: string }> {
    return this.inner.encryptCurrent(plaintext);
  }

  async decrypt(
    ciphertext: string,
    fingerprint: string | null
  ): Promise<string> {
    if (!this.cache.enabled) {
      return this.inner.decrypt(ciphertext, fingerprint);
    }
    const key = hashForCache(ciphertext);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const plaintext = await this.inner.decrypt(ciphertext, fingerprint);
    this.cache.set(key, plaintext);
    return plaintext;
  }

  /** For tests + /health introspection. */
  stats(): { hits: number; misses: number; size: number; enabled: boolean } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      enabled: this.cache.enabled,
    };
  }

  /** Purge all cached plaintexts. Call after a master-key rotation. */
  clear(): void {
    this.cache.clear();
  }
}

function readCacheOptsFromEnv(): CacheOptions {
  const ttl = process.env.TOKENSMART_KMS_CACHE_TTL_MS;
  const size = process.env.TOKENSMART_KMS_CACHE_MAX_SIZE;
  return {
    ttlMs: ttl != null ? Number(ttl) : 10 * 60 * 1000,
    maxSize: size != null ? Number(size) : 1000,
  };
}

/**
 * Wrap a raw provider with caching if (a) it's a KMS-family provider where
 * caching actually buys something and (b) the env opts don't disable it.
 * Env-backed providers are returned untouched — their decrypt is already
 * sub-millisecond.
 */
export function wrapWithCacheIfBeneficial(
  provider: ProviderKeyProvider
): ProviderKeyProvider {
  if (provider.name === "env") return provider;
  const opts = readCacheOptsFromEnv();
  if (opts.ttlMs <= 0 || opts.maxSize <= 0) return provider;
  return new CachingKeyProvider(provider, opts);
}
