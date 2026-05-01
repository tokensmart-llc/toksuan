/**
 * LruTtlCache + CachingKeyProvider tests. Uses the stub KMS client from
 * kms-provider.test.ts via a local copy so these run in isolation.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { CachingKeyProvider, type ProviderKeyProvider } from "../src/crypto";
import { KmsKeyProvider } from "../src/kms-provider";
import { LruTtlCache } from "../src/lru-ttl-cache";

describe("LruTtlCache", () => {
  test("set/get round-trips", () => {
    const c = new LruTtlCache<string>(10, 60_000);
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
  });

  test("expired entries are purged on get", async () => {
    const c = new LruTtlCache<string>(10, 10); // 10ms TTL
    c.set("k", "v");
    await new Promise((r) => setTimeout(r, 25));
    expect(c.get("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  test("eviction fires when over maxSize", () => {
    const c = new LruTtlCache<string>(2, 60_000);
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3"); // evicts 'a'
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("2");
    expect(c.get("c")).toBe("3");
  });

  test("get refreshes LRU position — least-recently-used is evicted, not least-recently-set", () => {
    const c = new LruTtlCache<string>(2, 60_000);
    c.set("a", "1");
    c.set("b", "2");
    // touch 'a' so 'b' becomes LRU
    c.get("a");
    c.set("c", "3"); // should evict 'b', not 'a'
    expect(c.get("a")).toBe("1");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe("3");
  });

  test("enabled=false when either limit is 0", () => {
    expect(new LruTtlCache<string>(0, 60_000).enabled).toBe(false);
    expect(new LruTtlCache<string>(10, 0).enabled).toBe(false);
    expect(new LruTtlCache<string>(10, 60_000).enabled).toBe(true);
  });

  test("disabled cache short-circuits both ops", () => {
    const c = new LruTtlCache<string>(0, 60_000);
    c.set("k", "v");
    expect(c.get("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  test("delete + clear", () => {
    const c = new LruTtlCache<string>(10, 60_000);
    c.set("a", "1");
    c.set("b", "2");
    c.delete("a");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("2");
    c.clear();
    expect(c.size).toBe(0);
  });
});

// ---- CachingKeyProvider vs real KmsKeyProvider (stub KMS) ---------------

function makeCountingStubClient(keyArn: string): {
  client: KMSClient;
  counts: { gen: number; decrypt: number };
} {
  const counts = { gen: 0, decrypt: 0 };
  const SENTINEL = Buffer.alloc(32, 0x5a);
  const unwrap = (wrapped: Buffer) => {
    const out = Buffer.alloc(wrapped.length);
    for (let i = 0; i < wrapped.length; i++) {
      out[i] = wrapped[i] ^ SENTINEL[i % SENTINEL.length];
    }
    return out;
  };
  const client = {
    async send(cmd: { input: unknown; constructor: { name: string } }) {
      const name = cmd.constructor.name;
      const input = cmd.input as {
        KeyId?: string;
        CiphertextBlob?: Uint8Array;
      };
      if (name === "GenerateDataKeyCommand") {
        counts.gen++;
        if (input.KeyId !== keyArn) throw new Error(`wrong KeyId`);
        const dek = randomBytes(32);
        const wrapped = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) wrapped[i] = dek[i] ^ SENTINEL[i];
        return {
          Plaintext: new Uint8Array(dek),
          CiphertextBlob: new Uint8Array(wrapped),
        };
      }
      if (name === "DecryptCommand") {
        counts.decrypt++;
        if (input.KeyId !== keyArn) throw new Error(`wrong KeyId`);
        if (!input.CiphertextBlob) throw new Error("missing CiphertextBlob");
        const dek = unwrap(Buffer.from(input.CiphertextBlob));
        return { Plaintext: new Uint8Array(dek) };
      }
      throw new Error(`unhandled command ${name}`);
    },
  } as unknown as KMSClient;
  return { client, counts };
}

const FAKE_ARN = "arn:aws:kms:us-east-1:123456789012:key/abcd";

describe("CachingKeyProvider", () => {
  test("second decrypt of same envelope skips KMS", async () => {
    const { client, counts } = makeCountingStubClient(FAKE_ARN);
    const raw = new KmsKeyProvider({ keyArn: FAKE_ARN, client });
    const cached = new CachingKeyProvider(raw, { ttlMs: 60_000, maxSize: 10 });

    const { ciphertext, fingerprint } = await cached.encryptCurrent("payload");
    expect(counts.gen).toBe(1);
    expect(counts.decrypt).toBe(0);

    expect(await cached.decrypt(ciphertext, fingerprint)).toBe("payload");
    expect(counts.decrypt).toBe(1);

    // Second call: same ciphertext → cache hit.
    expect(await cached.decrypt(ciphertext, fingerprint)).toBe("payload");
    expect(counts.decrypt).toBe(1); // unchanged

    const stats = cached.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.enabled).toBe(true);
  });

  test("different ciphertexts miss independently", async () => {
    const { client, counts } = makeCountingStubClient(FAKE_ARN);
    const raw = new KmsKeyProvider({ keyArn: FAKE_ARN, client });
    const cached = new CachingKeyProvider(raw, { ttlMs: 60_000, maxSize: 10 });

    const a = await cached.encryptCurrent("first");
    const b = await cached.encryptCurrent("second");
    expect(await cached.decrypt(a.ciphertext, a.fingerprint)).toBe("first");
    expect(await cached.decrypt(b.ciphertext, b.fingerprint)).toBe("second");
    expect(counts.decrypt).toBe(2);
    expect(cached.stats().size).toBe(2);
  });

  test("TTL expiry re-triggers KMS", async () => {
    const { client, counts } = makeCountingStubClient(FAKE_ARN);
    const raw = new KmsKeyProvider({ keyArn: FAKE_ARN, client });
    const cached = new CachingKeyProvider(raw, { ttlMs: 20, maxSize: 10 });

    const { ciphertext, fingerprint } = await cached.encryptCurrent("hello");
    await cached.decrypt(ciphertext, fingerprint);
    expect(counts.decrypt).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    await cached.decrypt(ciphertext, fingerprint);
    expect(counts.decrypt).toBe(2);
  });

  test("disabled cache is transparent (ttl=0)", async () => {
    const { client, counts } = makeCountingStubClient(FAKE_ARN);
    const raw = new KmsKeyProvider({ keyArn: FAKE_ARN, client });
    const cached = new CachingKeyProvider(raw, { ttlMs: 0, maxSize: 10 });
    expect(cached.stats().enabled).toBe(false);

    const { ciphertext, fingerprint } = await cached.encryptCurrent("x");
    await cached.decrypt(ciphertext, fingerprint);
    await cached.decrypt(ciphertext, fingerprint);
    expect(counts.decrypt).toBe(2); // every call hits KMS
  });

  test("clear() drops cached plaintexts", async () => {
    const { client, counts } = makeCountingStubClient(FAKE_ARN);
    const raw = new KmsKeyProvider({ keyArn: FAKE_ARN, client });
    const cached = new CachingKeyProvider(raw, { ttlMs: 60_000, maxSize: 10 });

    const { ciphertext, fingerprint } = await cached.encryptCurrent("x");
    await cached.decrypt(ciphertext, fingerprint);
    expect(counts.decrypt).toBe(1);
    cached.clear();
    await cached.decrypt(ciphertext, fingerprint);
    expect(counts.decrypt).toBe(2);
  });

  test("passthrough for name/canHandle/fingerprint/encryptCurrent", async () => {
    const { client } = makeCountingStubClient(FAKE_ARN);
    const raw: ProviderKeyProvider = new KmsKeyProvider({
      keyArn: FAKE_ARN,
      client,
    });
    const cached = new CachingKeyProvider(raw, { ttlMs: 60_000, maxSize: 10 });
    expect(cached.name).toBe("kms");
    expect(cached.currentFingerprint()).toBe(raw.currentFingerprint());
    expect(cached.canHandle("kms:deadbeef")).toBe(true);
    expect(cached.canHandle("5ebbde05")).toBe(false);
  });
});
