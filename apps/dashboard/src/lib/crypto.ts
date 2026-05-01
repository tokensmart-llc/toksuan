import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM helpers for BYO upstream-provider-key storage.
 *
 * Mirror of `apps/gateway/src/crypto.ts` — both processes share the same
 * `TOKENSMART_PROVIDER_KEY_ENCRYPTION` master key so the dashboard can
 * encrypt and the gateway can decrypt without a network round-trip.
 *
 * Master key formats accepted:
 *   - 64 hex chars (`openssl rand -hex 32`)
 *   - base64 of 32 bytes (`openssl rand -base64 32`)
 *
 * Wire format on disk: base64( IV(12B) || ciphertext || GCM-tag(16B) ).
 *
 * The `ProviderKeyProvider` interface defined below is the policy layer
 * the dashboard's settings actions actually call. Today it's backed by
 * `EnvKeyProvider` (master key from env). When we plug in AWS KMS later,
 * a new `KmsKeyProvider` implementation drops in here without touching any
 * call site. See `apps/gateway/src/crypto.ts` for the full design notes.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function parseEncryptionKey(raw: string, label: string): Buffer {
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
      `${label} must decode to exactly ${KEY_LEN} bytes (got ${buf.length})`
    );
  }
  return buf;
}

function masterKeyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function encryptWith(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

function decryptWith(blob: string, key: Buffer): string {
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

export interface ProviderKeyProvider {
  readonly name: "env" | "kms";
  isConfigured(): boolean;
  currentFingerprint(): string;
  canHandle(fingerprint: string): boolean;
  encryptCurrent(
    plaintext: string
  ): Promise<{ ciphertext: string; fingerprint: string }>;
  decrypt(ciphertext: string, fingerprint: string | null): Promise<string>;
}

// ---- Envelope helpers (shared with gateway/src/crypto.ts) ---------------

const ENVELOPE_MAGIC_V1 = 0x01;

function packEnvelope(
  wrappedDek: Buffer,
  iv: Buffer,
  ciphertextWithTag: Buffer
): string {
  if (wrappedDek.length > 0xffff) {
    throw new Error(
      `wrapped DEK too large (${wrappedDek.length} bytes); max ${0xffff}`
    );
  }
  const header = Buffer.alloc(3);
  header.writeUInt8(ENVELOPE_MAGIC_V1, 0);
  header.writeUInt16BE(wrappedDek.length, 1);
  return Buffer.concat([
    header,
    wrappedDek,
    iv,
    ciphertextWithTag,
  ]).toString("base64");
}

function aesGcmEncrypt(plaintext: string, dek: Buffer) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertextWithTag: Buffer.concat([ct, tag]) };
}

class EnvKeyProvider implements ProviderKeyProvider {
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
          `current env key is ${masterKeyFingerprint(key)}.`
      );
    }
    return decryptWith(blob, key);
  }
}

// ---- KMS provider (envelope encryption via AWS KMS) ---------------------

/**
 * Dashboard-side KMS implementation. The dashboard only ever ENCRYPTS
 * (customer pastes a provider key into /settings → we wrap it → write to
 * DB). Decryption happens in the gateway with its own crypto module.
 *
 * The gateway's `kms-provider.ts` has the full design doc + IAM policy
 * notes — this file is the minimal mirror needed for encrypts.
 */
class KmsKeyProvider implements ProviderKeyProvider {
  readonly name = "kms" as const;
  private readonly keyArn: string;
  private readonly fingerprint: string;
  private clientPromise: Promise<
    import("@aws-sdk/client-kms").KMSClient | null
  > | null = null;

  constructor(opts: { keyArn: string; region?: string; endpoint?: string }) {
    this.keyArn = opts.keyArn;
    this.fingerprint = kmsFingerprintFromArn(opts.keyArn);
    // Lazy SDK load so the Next bundle doesn't include it unless actually
    // needed at runtime.
    this.clientPromise = (async () => {
      const mod = await import("@aws-sdk/client-kms");
      return new mod.KMSClient({
        region: opts.region,
        endpoint: opts.endpoint,
      });
    })();
  }

  isConfigured(): boolean {
    return Boolean(this.keyArn);
  }

  currentFingerprint(): string {
    return this.fingerprint;
  }

  canHandle(fingerprint: string): boolean {
    return fingerprint.startsWith("kms:");
  }

  async encryptCurrent(
    plaintext: string
  ): Promise<{ ciphertext: string; fingerprint: string }> {
    const client = await this.clientPromise!;
    if (!client) throw new Error("KMS client failed to initialize");
    const { GenerateDataKeyCommand } = await import("@aws-sdk/client-kms");
    const res = await client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyArn,
        KeySpec: "AES_256",
      })
    );
    if (!res.Plaintext || !res.CiphertextBlob) {
      throw new Error("KMS GenerateDataKey returned incomplete response");
    }
    const dek = Buffer.from(res.Plaintext);
    try {
      const { iv, ciphertextWithTag } = aesGcmEncrypt(plaintext, dek);
      const wrappedDek = Buffer.from(res.CiphertextBlob);
      return {
        ciphertext: packEnvelope(wrappedDek, iv, ciphertextWithTag),
        fingerprint: this.fingerprint,
      };
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(): Promise<string> {
    // The dashboard never decrypts BYO provider keys — that's the gateway's
    // job. Present for interface parity.
    throw new Error(
      "KmsKeyProvider.decrypt is not available in the dashboard process"
    );
  }
}

function kmsFingerprintFromArn(keyArn: string): string {
  const hash = createHash("sha256").update(keyArn).digest("hex").slice(0, 8);
  return `kms:${hash}`;
}

// ---- Registry -----------------------------------------------------------

const envKeyProvider = new EnvKeyProvider();

let kmsProvider: KmsKeyProvider | null = null;
let kmsInitialized = false;

function getKmsProvider(): KmsKeyProvider | null {
  if (kmsInitialized) return kmsProvider;
  kmsInitialized = true;
  const arn = process.env.TOKENSMART_KMS_KEY_ARN?.trim();
  if (!arn) {
    kmsProvider = null;
    return null;
  }
  kmsProvider = new KmsKeyProvider({
    keyArn: arn,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    endpoint: process.env.TOKENSMART_KMS_ENDPOINT_URL,
  });
  return kmsProvider;
}

/** The backend used for NEW encrypts (customer pasting a new key). */
export function getActiveKeyProvider(): ProviderKeyProvider {
  const kms = getKmsProvider();
  if (kms?.isConfigured()) return kms;
  return envKeyProvider;
}

/** @deprecated alias for `getActiveKeyProvider`. */
export function getKeyProvider(): ProviderKeyProvider {
  return getActiveKeyProvider();
}

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
  // Dashboard doesn't decrypt in practice, but the function exists for
  // parity with the gateway module.
  const provider = getActiveKeyProvider();
  return provider.decrypt(blob, fingerprint);
}
