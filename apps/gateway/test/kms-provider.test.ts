/**
 * KmsKeyProvider unit tests. Uses a stub KMS client so these run anywhere
 * without AWS credentials or LocalStack.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  packEnvelope,
  unpackEnvelope,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from "../src/crypto";
import { KmsKeyProvider, kmsFingerprintFromArn } from "../src/kms-provider";

/**
 * Fake KMS that implements just GenerateDataKey + Decrypt:
 *   - GenerateDataKey returns a random 32-byte DEK as Plaintext and the
 *     same 32 bytes xor'd with a sentinel as CiphertextBlob. That makes
 *     Decrypt purely deterministic (xor back).
 *   - Rejects Decrypt when KeyId doesn't match (like real KMS).
 * Enough surface to exercise the envelope code end-to-end.
 */
function makeStubKmsClient(keyArn: string): KMSClient {
  const SENTINEL = Buffer.alloc(32, 0x5a);
  const unwrap = (wrapped: Buffer) => {
    const out = Buffer.alloc(wrapped.length);
    for (let i = 0; i < wrapped.length; i++) {
      out[i] = wrapped[i] ^ SENTINEL[i % SENTINEL.length];
    }
    return out;
  };

  return {
    // Minimal subset of the KMSClient interface that KmsKeyProvider touches.
    async send(cmd: { input: unknown; constructor: { name: string } }) {
      const name = cmd.constructor.name;
      const input = cmd.input as { KeyId?: string; CiphertextBlob?: Uint8Array };
      if (name === "GenerateDataKeyCommand") {
        if (input.KeyId !== keyArn) {
          throw new Error(`wrong KeyId: ${input.KeyId}`);
        }
        const dek = randomBytes(32);
        const wrapped = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) wrapped[i] = dek[i] ^ SENTINEL[i];
        return { Plaintext: new Uint8Array(dek), CiphertextBlob: new Uint8Array(wrapped) };
      }
      if (name === "DecryptCommand") {
        if (input.KeyId !== keyArn) {
          throw new Error(`wrong KeyId: ${input.KeyId}`);
        }
        if (!input.CiphertextBlob) throw new Error("missing CiphertextBlob");
        const dek = unwrap(Buffer.from(input.CiphertextBlob));
        return { Plaintext: new Uint8Array(dek) };
      }
      throw new Error(`stub KMS: unhandled command ${name}`);
    },
  } as unknown as KMSClient;
}

const FAKE_ARN = "arn:aws:kms:us-east-1:123456789012:key/abcd-1234-5678-efgh";

describe("envelope format", () => {
  test("pack/unpack round-trips arbitrary wrapped DEK sizes", () => {
    for (const dekLen of [10, 183, 512, 8192]) {
      const wrappedDek = randomBytes(dekLen);
      const iv = randomBytes(12);
      const ct = randomBytes(dekLen + 17); // arbitrary payload
      const blob = packEnvelope(wrappedDek, iv, ct);
      const unpacked = unpackEnvelope(blob);
      expect(unpacked.wrappedDek.equals(wrappedDek)).toBe(true);
      expect(unpacked.iv.equals(iv)).toBe(true);
      // ciphertext+tag split is conventional; concat should match the input
      const ctPlusTag = Buffer.concat([unpacked.ciphertext, unpacked.tag]);
      expect(ctPlusTag.equals(ct)).toBe(true);
    }
  });

  test("rejects blob that's too short", () => {
    expect(() => unpackEnvelope(Buffer.from("short").toString("base64"))).toThrow(
      /envelope blob too short/
    );
  });

  test("rejects wrong magic byte", () => {
    // Manually craft a blob with magic 0xff
    const wrong = Buffer.concat([
      Buffer.from([0xff, 0, 0]),
      randomBytes(12 + 16),
    ]);
    expect(() => unpackEnvelope(wrong.toString("base64"))).toThrow(
      /unknown envelope magic/
    );
  });
});

describe("AES-GCM primitives", () => {
  test("encrypt + decrypt round-trip", () => {
    const dek = randomBytes(32);
    const { iv, ciphertextWithTag } = aesGcmEncrypt(
      "fixture-provider-key",
      dek
    );
    // ciphertextWithTag layout: ciphertext || 16-byte tag
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const ct = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
    const out = aesGcmDecrypt(ct, tag, iv, dek);
    expect(out).toBe("fixture-provider-key");
  });

  test("decrypt with wrong DEK throws", () => {
    const dek = randomBytes(32);
    const { iv, ciphertextWithTag } = aesGcmEncrypt("hello", dek);
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const ct = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
    expect(() => aesGcmDecrypt(ct, tag, iv, randomBytes(32))).toThrow();
  });
});

describe("KmsKeyProvider (stub KMS)", () => {
  test("encrypt → decrypt round-trips", async () => {
    const provider = new KmsKeyProvider({
      keyArn: FAKE_ARN,
      client: makeStubKmsClient(FAKE_ARN),
    });
    expect(provider.isConfigured()).toBe(true);

    const { ciphertext, fingerprint } = await provider.encryptCurrent(
      "sk-hosted-saas-example"
    );
    expect(fingerprint).toBe(kmsFingerprintFromArn(FAKE_ARN));
    expect(fingerprint.startsWith("kms:")).toBe(true);

    const plaintext = await provider.decrypt(ciphertext, fingerprint);
    expect(plaintext).toBe("sk-hosted-saas-example");
  });

  test("decrypt with mismatched fingerprint throws", async () => {
    const provider = new KmsKeyProvider({
      keyArn: FAKE_ARN,
      client: makeStubKmsClient(FAKE_ARN),
    });
    const { ciphertext } = await provider.encryptCurrent("secret");
    expect(
      provider.decrypt(ciphertext, "kms:deadbeef")
    ).rejects.toThrow(/KMS key mismatch/);
  });

  test("canHandle routes kms:* fingerprints and rejects env hex", () => {
    const provider = new KmsKeyProvider({
      keyArn: FAKE_ARN,
      client: makeStubKmsClient(FAKE_ARN),
    });
    expect(provider.canHandle("kms:abcdef01")).toBe(true);
    expect(provider.canHandle("5ebbde05")).toBe(false); // env fingerprint
    expect(provider.canHandle("")).toBe(false);
  });

  test("fingerprints are deterministic across instances", () => {
    const a = new KmsKeyProvider({
      keyArn: FAKE_ARN,
      client: makeStubKmsClient(FAKE_ARN),
    });
    const b = new KmsKeyProvider({
      keyArn: FAKE_ARN,
      client: makeStubKmsClient(FAKE_ARN),
    });
    expect(a.currentFingerprint()).toBe(b.currentFingerprint());
  });

  test("different ARNs yield different fingerprints", () => {
    const other = "arn:aws:kms:us-west-2:123456789012:key/different";
    expect(kmsFingerprintFromArn(FAKE_ARN)).not.toBe(
      kmsFingerprintFromArn(other)
    );
  });

  test("decrypt with NULL fingerprint still works (KMS-written row)", async () => {
    // Shouldn't happen in practice (we always stamp the fingerprint), but
    // the interface allows NULL for legacy rows — verify the behavior.
    const provider = new KmsKeyProvider({
      keyArn: FAKE_ARN,
      client: makeStubKmsClient(FAKE_ARN),
    });
    const { ciphertext } = await provider.encryptCurrent("payload");
    const plaintext = await provider.decrypt(ciphertext, null);
    expect(plaintext).toBe("payload");
  });
});
