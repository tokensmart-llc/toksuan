import { createHash } from "node:crypto";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  packEnvelope,
  unpackEnvelope,
  type ProviderKeyProvider,
} from "./crypto";

/**
 * AWS KMS–backed `ProviderKeyProvider` using envelope encryption.
 *
 * Why envelope:
 *   - AWS KMS `Encrypt` has a 4 KB plaintext limit — too small for large
 *     provider keys + metadata. Envelope encryption bypasses this.
 *   - KMS has per-region request-rate limits (~10k/s on symmetric keys by
 *     default, less on large accounts). A naive "call Encrypt/Decrypt per
 *     request" design caps tenant throughput on the KMS quota, not on your
 *     app server. Envelope amortizes.
 *   - Each row gets an independent random 256-bit DEK, so compromising one
 *     row's plaintext doesn't let an attacker decrypt any other row.
 *
 * How it works:
 *
 *   encryptCurrent(plaintext):
 *     1. GenerateDataKey(KeyId=CMK, KeySpec=AES_256)   ← 1 KMS round-trip
 *        → { Plaintext: 32B DEK, CiphertextBlob: wrapped DEK }
 *     2. AES-256-GCM encrypt plaintext using the DEK.
 *     3. Return envelope blob:
 *          base64( magic || len(wrappedDEK) || wrappedDEK || iv || ct || tag )
 *
 *   decrypt(blob, fingerprint):
 *     1. Unpack the envelope to extract wrappedDEK, iv, ct, tag.
 *     2. Decrypt(CiphertextBlob=wrappedDEK)             ← 1 KMS round-trip
 *        → { Plaintext: 32B DEK }
 *     3. AES-256-GCM decrypt with the DEK.
 *
 * Fingerprint format: `kms:<first-8-hex-of-sha256(keyArn)>`. Stable,
 * distinguishable from env fingerprints (pure hex), and never reveals the
 * region/account in the clear to anyone who scrapes the DB.
 *
 * Minimum IAM policy for the gateway's IAM role (attach to either a
 * specific CMK ARN or `"*"` scoped to your account):
 *
 *   {
 *     "Version": "2012-10-17",
 *     "Statement": [{
 *       "Effect": "Allow",
 *       "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
 *       "Resource": "arn:aws:kms:us-east-1:<account>:key/<key-id>"
 *     }]
 *   }
 *
 * Do NOT grant `kms:Encrypt` — envelope encryption doesn't need it, and
 * denying it reduces blast radius if a token leaks.
 *
 * NOT BUILT YET (follow-up PR): in-memory LRU of (wrappedDEK → DEK) so
 * repeated requests to the same BYO user don't hit KMS every time. TTL
 * 5-10 min. Without it every gateway request costs 1 KMS Decrypt round
 * trip, which is ~5-20 ms and counts against the KMS rate limit.
 */
export class KmsKeyProvider implements ProviderKeyProvider {
  readonly name = "kms" as const;

  private _client: KMSClient | null = null;
  private readonly keyArn: string;
  private readonly fingerprint: string;
  private readonly region?: string;
  private readonly endpoint?: string;
  private readonly injectedClient?: KMSClient;

  constructor(opts: {
    keyArn: string;
    region?: string;
    endpoint?: string;
    /**
     * Dependency injection for tests — a stub KMSClient that returns
     * deterministic DEKs. Default uses the real AWS SDK configured by env.
     */
    client?: KMSClient;
  }) {
    this.keyArn = opts.keyArn;
    this.fingerprint = kmsFingerprintFromArn(opts.keyArn);
    this.region = opts.region;
    this.endpoint = opts.endpoint;
    this.injectedClient = opts.client;
  }

  /**
   * Lazily construct the AWS SDK client. Deferred so merely instantiating a
   * KmsKeyProvider doesn't force region / credential resolution — useful
   * during tests (registry routing) and during the migration window where
   * we want to validate config without talking to AWS yet.
   */
  private get client(): KMSClient {
    if (this._client) return this._client;
    this._client =
      this.injectedClient ??
      new KMSClient({ region: this.region, endpoint: this.endpoint });
    return this._client;
  }

  isConfigured(): boolean {
    // Presence of the ARN is enough — AWS SDK will surface credential
    // problems on the first call.
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
    const res = await this.client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyArn,
        KeySpec: "AES_256",
      })
    );
    if (!res.Plaintext || !res.CiphertextBlob) {
      throw new Error(
        "KMS GenerateDataKey returned an incomplete response (missing Plaintext or CiphertextBlob)"
      );
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
      // Zero the DEK plaintext as soon as we're done with it. Node doesn't
      // give us true constant-time wipe, but clobbering the bytes means a
      // heap dump 100ms later doesn't have this DEK in it.
      dek.fill(0);
    }
  }

  async decrypt(
    ciphertext: string,
    fingerprint: string | null
  ): Promise<string> {
    if (fingerprint != null && fingerprint !== this.fingerprint) {
      // Row references a different KMS CMK than the one we're configured
      // against. Most common cause: operator rotated the CMK but hasn't
      // run `migrate-to-kms` yet, so some rows still point at the old ARN.
      throw new Error(
        `KMS key mismatch: row encrypted with fingerprint ${fingerprint}, current KMS key is ${this.fingerprint}`
      );
    }
    const { wrappedDek, iv, ciphertext: ct, tag } = unpackEnvelope(ciphertext);
    const res = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: wrappedDek,
        KeyId: this.keyArn,
      })
    );
    if (!res.Plaintext) {
      throw new Error("KMS Decrypt returned no Plaintext");
    }
    const dek = Buffer.from(res.Plaintext);
    try {
      return aesGcmDecrypt(ct, tag, iv, dek);
    } finally {
      dek.fill(0);
    }
  }
}

/**
 * Deterministic short fingerprint of a KMS Key ARN. Prefix `kms:` makes it
 * unambiguous against env-provider fingerprints (which are hex only).
 */
export function kmsFingerprintFromArn(keyArn: string): string {
  const hash = createHash("sha256").update(keyArn).digest("hex").slice(0, 8);
  return `kms:${hash}`;
}
