/**
 * GcpKmsKeyProvider unit tests with a stub KMS client — no real GCP
 * credentials, no network calls.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  GcpKmsKeyProvider,
  gcpKmsFingerprintFromKeyName,
  type GcpKmsClientLike,
} from "../src/gcp-kms-provider";

/**
 * Stub GCP KMS: `encrypt(dek)` → XORs with a sentinel → "wrapped" DEK;
 * `decrypt(wrapped)` → reverses. Both check that the requested `name`
 * matches the configured key resource, exactly like real GCP KMS.
 */
function makeStubClient(keyName: string): {
  client: GcpKmsClientLike;
  counts: { encrypt: number; decrypt: number };
} {
  const counts = { encrypt: 0, decrypt: 0 };
  const SENTINEL = Buffer.alloc(32, 0xa7);
  const xorWith = (src: Buffer) => {
    const out = Buffer.alloc(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = src[i] ^ SENTINEL[i % SENTINEL.length];
    }
    return out;
  };
  const client: GcpKmsClientLike = {
    async encrypt({ name, plaintext }) {
      counts.encrypt++;
      if (name !== keyName) throw new Error(`wrong name: ${name}`);
      const wrapped = xorWith(plaintext);
      return [{ ciphertext: new Uint8Array(wrapped) }];
    },
    async decrypt({ name, ciphertext }) {
      counts.decrypt++;
      if (name !== keyName) throw new Error(`wrong name: ${name}`);
      const dek = xorWith(Buffer.from(ciphertext));
      return [{ plaintext: new Uint8Array(dek) }];
    },
  };
  return { client, counts };
}

const FAKE_NAME =
  "projects/fake-proj/locations/global/keyRings/test-ring/cryptoKeys/test-key";

describe("GcpKmsKeyProvider (stub client)", () => {
  test("encrypt → decrypt round-trips", async () => {
    const { client, counts } = makeStubClient(FAKE_NAME);
    const provider = new GcpKmsKeyProvider({ keyName: FAKE_NAME, client });

    expect(provider.isConfigured()).toBe(true);
    expect(provider.currentFingerprint()).toBe(
      gcpKmsFingerprintFromKeyName(FAKE_NAME)
    );
    expect(provider.currentFingerprint().startsWith("gcp:")).toBe(true);

    const { ciphertext, fingerprint } = await provider.encryptCurrent(
      "sk-gcp-byo-example"
    );
    expect(fingerprint).toBe(provider.currentFingerprint());
    expect(counts.encrypt).toBe(1);

    const plain = await provider.decrypt(ciphertext, fingerprint);
    expect(plain).toBe("sk-gcp-byo-example");
    expect(counts.decrypt).toBe(1);
  });

  test("canHandle routes gcp:* and rejects other prefixes", () => {
    const { client } = makeStubClient(FAKE_NAME);
    const provider = new GcpKmsKeyProvider({ keyName: FAKE_NAME, client });
    expect(provider.canHandle("gcp:abcdef01")).toBe(true);
    expect(provider.canHandle("kms:abcdef01")).toBe(false);
    expect(provider.canHandle("5ebbde05")).toBe(false);
    expect(provider.canHandle("")).toBe(false);
  });

  test("mismatched fingerprint refuses decrypt", async () => {
    const { client } = makeStubClient(FAKE_NAME);
    const provider = new GcpKmsKeyProvider({ keyName: FAKE_NAME, client });
    const { ciphertext } = await provider.encryptCurrent("secret");
    expect(provider.decrypt(ciphertext, "gcp:00000000")).rejects.toThrow(
      /GCP KMS key mismatch/
    );
  });

  test("fingerprints are deterministic across instances", () => {
    const stub = makeStubClient(FAKE_NAME);
    const a = new GcpKmsKeyProvider({ keyName: FAKE_NAME, client: stub.client });
    const b = new GcpKmsKeyProvider({ keyName: FAKE_NAME, client: stub.client });
    expect(a.currentFingerprint()).toBe(b.currentFingerprint());
  });

  test("different key names yield different fingerprints", () => {
    const other =
      "projects/fake-proj/locations/global/keyRings/test-ring/cryptoKeys/OTHER";
    expect(gcpKmsFingerprintFromKeyName(FAKE_NAME)).not.toBe(
      gcpKmsFingerprintFromKeyName(other)
    );
  });

  test("handles base64-string ciphertext returns from the SDK", async () => {
    // Some GCP SDK call sites return ciphertext as a base64 string instead
    // of Uint8Array (depends on protobuf mode). Verify the provider copes.
    const SENTINEL = Buffer.alloc(32, 0xa7);
    const xor = (src: Buffer) => {
      const out = Buffer.alloc(src.length);
      for (let i = 0; i < src.length; i++) out[i] = src[i] ^ SENTINEL[i];
      return out;
    };
    const b64Client: GcpKmsClientLike = {
      async encrypt({ plaintext }) {
        const wrapped = xor(plaintext);
        return [{ ciphertext: wrapped.toString("base64") }];
      },
      async decrypt({ ciphertext }) {
        const dek = xor(Buffer.from(ciphertext));
        return [{ plaintext: new Uint8Array(dek) }];
      },
    };
    const provider = new GcpKmsKeyProvider({
      keyName: FAKE_NAME,
      client: b64Client,
    });
    const { ciphertext, fingerprint } = await provider.encryptCurrent(
      "payload"
    );
    const out = await provider.decrypt(ciphertext, fingerprint);
    expect(out).toBe("payload");
  });

  test("empty ciphertext response throws", async () => {
    const bad: GcpKmsClientLike = {
      async encrypt() {
        return [{ ciphertext: null }];
      },
      async decrypt() {
        return [{ plaintext: null }];
      },
    };
    const provider = new GcpKmsKeyProvider({ keyName: FAKE_NAME, client: bad });
    expect(provider.encryptCurrent("x")).rejects.toThrow(/no ciphertext/);
  });

  test("larger payloads (2KB) encrypt + decrypt correctly", async () => {
    const { client } = makeStubClient(FAKE_NAME);
    const provider = new GcpKmsKeyProvider({ keyName: FAKE_NAME, client });
    const big = randomBytes(2048).toString("hex");
    const { ciphertext, fingerprint } = await provider.encryptCurrent(big);
    const out = await provider.decrypt(ciphertext, fingerprint);
    expect(out).toBe(big);
  });
});
