import { createHash, randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  packEnvelope,
  unpackEnvelope,
  type ProviderKeyProvider,
} from "./crypto";

/**
 * Google Cloud KMS–backed `ProviderKeyProvider` using envelope encryption.
 *
 * Differences from the AWS version (`KmsKeyProvider`):
 *
 *   - GCP KMS has no equivalent of AWS `GenerateDataKey`. We generate the
 *     DEK locally with `crypto.randomBytes(32)` and then call
 *     `kms.encrypt` to wrap it. This means one extra step on the app side
 *     but the protocol is otherwise identical.
 *   - GCP key names are resource paths, not ARNs:
 *       projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>
 *   - Auth goes through Application Default Credentials (ADC): a GKE
 *     Workload Identity binding, `GOOGLE_APPLICATION_CREDENTIALS` env
 *     pointing at a service-account JSON, or metadata-server creds on GCE.
 *     The SDK figures it out; we don't read creds ourselves.
 *
 * Fingerprint: `gcp:<first-8-hex-of-sha256(keyName)>`. Distinguishable from
 * AWS (`kms:`) and env (pure hex) fingerprints so the registry can dispatch
 * unambiguously.
 *
 * Minimum IAM on the GCP service account:
 *   - roles/cloudkms.cryptoKeyEncrypter OR the granular
 *     cloudkms.cryptoKeyVersions.useToEncrypt permission
 *   - roles/cloudkms.cryptoKeyDecrypter OR the granular
 *     cloudkms.cryptoKeyVersions.useToDecrypt permission
 *   (The combined role `roles/cloudkms.cryptoKeyEncrypterDecrypter` works too.)
 *
 * Do NOT grant cloudkms.admin — we never create, destroy, or rotate keys
 * from the app side.
 */

/** Subset of the GCP KMS client that this provider actually uses. Narrow
 *  on purpose so tests can stub without recreating the full typings. */
export type GcpKmsClientLike = {
  encrypt(req: {
    name: string;
    plaintext: Buffer;
  }): Promise<
    [{ ciphertext?: Uint8Array | string | null } | undefined, ...unknown[]]
  >;
  decrypt(req: {
    name: string;
    ciphertext: Uint8Array;
  }): Promise<
    [{ plaintext?: Uint8Array | string | null } | undefined, ...unknown[]]
  >;
};

export class GcpKmsKeyProvider implements ProviderKeyProvider {
  readonly name = "kms" as const;
  // We use the `gcp:` fingerprint prefix but keep the provider's `name`
  // field at "kms" — the ProviderKeyProvider interface treats GCP and AWS
  // as the same shape and the dispatcher uses fingerprint prefix to route.
  // This keeps the abstract cost-analysis ("KMS-backed vs env-backed")
  // clean.

  private readonly client: GcpKmsClientLike;
  private readonly keyName: string;
  private readonly fingerprint: string;

  constructor(opts: {
    keyName: string;
    /** DI for tests. Default: real GCP client via ADC. */
    client?: GcpKmsClientLike;
  }) {
    this.keyName = opts.keyName;
    this.fingerprint = gcpKmsFingerprintFromKeyName(opts.keyName);
    this.client = opts.client ?? (new KeyManagementServiceClient() as unknown as GcpKmsClientLike);
  }

  isConfigured(): boolean {
    return Boolean(this.keyName);
  }

  currentFingerprint(): string {
    return this.fingerprint;
  }

  canHandle(fingerprint: string): boolean {
    return fingerprint.startsWith("gcp:");
  }

  async encryptCurrent(
    plaintext: string
  ): Promise<{ ciphertext: string; fingerprint: string }> {
    // Step 1: generate a local DEK.
    const dek = randomBytes(32);
    try {
      // Step 2: wrap the DEK with KMS.
      const [wrapResp] = await this.client.encrypt({
        name: this.keyName,
        plaintext: dek,
      });
      const wrappedRaw = wrapResp?.ciphertext;
      if (!wrappedRaw) {
        throw new Error(
          "GCP KMS encrypt returned no ciphertext (wrapped DEK missing)"
        );
      }
      const wrappedDek = toBuffer(wrappedRaw);

      // Step 3: AES-GCM encrypt the actual plaintext with the DEK.
      const { iv, ciphertextWithTag } = aesGcmEncrypt(plaintext, dek);
      return {
        ciphertext: packEnvelope(wrappedDek, iv, ciphertextWithTag),
        fingerprint: this.fingerprint,
      };
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(
    ciphertext: string,
    fingerprint: string | null
  ): Promise<string> {
    if (fingerprint != null && fingerprint !== this.fingerprint) {
      throw new Error(
        `GCP KMS key mismatch: row encrypted with fingerprint ${fingerprint}, current key is ${this.fingerprint}`
      );
    }
    const { wrappedDek, iv, ciphertext: ct, tag } = unpackEnvelope(ciphertext);
    const [resp] = await this.client.decrypt({
      name: this.keyName,
      ciphertext: new Uint8Array(wrappedDek),
    });
    const raw = resp?.plaintext;
    if (!raw) throw new Error("GCP KMS decrypt returned no plaintext");
    const dek = toBuffer(raw);
    try {
      return aesGcmDecrypt(ct, tag, iv, dek);
    } finally {
      dek.fill(0);
    }
  }
}

function toBuffer(value: Uint8Array | string): Buffer {
  if (typeof value === "string") {
    // GCP SDK sometimes returns base64-encoded strings depending on wire format.
    return Buffer.from(value, "base64");
  }
  return Buffer.from(value);
}

/**
 * Deterministic short fingerprint of a GCP KMS key resource name. Prefix
 * `gcp:` makes it unambiguous against AWS KMS (`kms:`) and env (pure hex).
 */
export function gcpKmsFingerprintFromKeyName(keyName: string): string {
  const hash = createHash("sha256").update(keyName).digest("hex").slice(0, 8);
  return `gcp:${hash}`;
}
