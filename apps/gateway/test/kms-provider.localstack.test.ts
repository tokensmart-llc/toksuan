/**
 * LocalStack integration test for `KmsKeyProvider`. Exercises the REAL
 * AWS SDK v3 client-kms against LocalStack's emulated KMS endpoint — the
 * one path our stubbed unit tests can't cover is "does the request-signing
 * and response-deserialization actually match AWS's wire format".
 *
 * Auto-skips when LocalStack isn't reachable, so `bun test` still passes
 * cleanly on developer machines without the test infrastructure up.
 *
 * To run:
 *   docker compose -f docker-compose.test.yml up -d localstack
 *   ./scripts/test-setup-localstack.sh
 *   source .localstack-kms.env
 *   cd apps/gateway && bun test
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { KMSClient, CreateKeyCommand } from "@aws-sdk/client-kms";
import { KmsKeyProvider } from "../src/kms-provider";
import { CachingKeyProvider } from "../src/crypto";

const ENDPOINT =
  process.env.TOKENSMART_KMS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";

async function isLocalStackReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${ENDPOINT}/_localstack/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Shared setup: if LocalStack is available, mint a fresh CMK for this
// test run. Test suites just skip when CMK is null.
let cmkArn: string | null = null;
let client: KMSClient | null = null;

beforeAll(async () => {
  const reachable = await isLocalStackReachable();
  if (!reachable) {
    console.log(
      `[localstack] ${ENDPOINT} not reachable — skipping LocalStack integration tests. ` +
        `Run \`docker compose -f docker-compose.test.yml up -d localstack\` to enable.`
    );
    return;
  }
  // Stuff dummy credentials the SDK expects.
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";

  client = new KMSClient({ region: REGION, endpoint: ENDPOINT });
  if (process.env.TOKENSMART_KMS_KEY_ARN) {
    cmkArn = process.env.TOKENSMART_KMS_KEY_ARN;
  } else {
    const res = await client.send(
      new CreateKeyCommand({ Description: "tokensmart-test-cmk-autoboot" })
    );
    cmkArn = res.KeyMetadata?.Arn ?? null;
    if (!cmkArn) throw new Error("LocalStack CreateKey returned no ARN");
  }
});

afterAll(() => {
  // Best-effort: let LocalStack's ephemeral state clean itself on
  // container down. Nothing else to do.
});

describe("KmsKeyProvider against LocalStack", () => {
  test("encrypt → decrypt round-trips against real AWS SDK", async () => {
    if (!cmkArn || !client) return; // skipped — LocalStack absent
    const provider = new KmsKeyProvider({
      keyArn: cmkArn,
      region: REGION,
      endpoint: ENDPOINT,
      client,
    });

    const { ciphertext, fingerprint } = await provider.encryptCurrent(
      "localstack-provider-key-fixture"
    );
    expect(fingerprint.startsWith("kms:")).toBe(true);

    const out = await provider.decrypt(ciphertext, fingerprint);
    expect(out).toBe("localstack-provider-key-fixture");
  });

  test("large payload (4KB) round-trips", async () => {
    if (!cmkArn || !client) return;
    const provider = new KmsKeyProvider({
      keyArn: cmkArn,
      region: REGION,
      endpoint: ENDPOINT,
      client,
    });
    const big = "x".repeat(4096);
    const { ciphertext, fingerprint } = await provider.encryptCurrent(big);
    const out = await provider.decrypt(ciphertext, fingerprint);
    expect(out).toBe(big);
  });

  test("cache decorator wins on second read", async () => {
    if (!cmkArn || !client) return;
    const raw = new KmsKeyProvider({
      keyArn: cmkArn,
      region: REGION,
      endpoint: ENDPOINT,
      client,
    });
    const cached = new CachingKeyProvider(raw, {
      ttlMs: 60_000,
      maxSize: 10,
    });

    const { ciphertext, fingerprint } = await cached.encryptCurrent("cache-test");

    // Warm the cache.
    const t1 = Date.now();
    await cached.decrypt(ciphertext, fingerprint);
    const firstCallMs = Date.now() - t1;

    // Cached read should be dramatically faster than the KMS round-trip.
    const t2 = Date.now();
    await cached.decrypt(ciphertext, fingerprint);
    const secondCallMs = Date.now() - t2;

    expect(cached.stats().hits).toBe(1);
    expect(cached.stats().misses).toBe(1);
    // LocalStack is fast (often <10ms) but still slower than an in-process
    // Map lookup. Guard against flaky timing by asserting only that the
    // hit is faster — not a specific margin.
    expect(secondCallMs).toBeLessThanOrEqual(firstCallMs);
  });

  test("mismatched CMK rejects decrypt", async () => {
    if (!cmkArn || !client) return;
    // Mint a second CMK and try to decrypt a blob from the first one with it.
    const other = await client.send(
      new CreateKeyCommand({ Description: "tokensmart-test-cmk-OTHER" })
    );
    const otherArn = other.KeyMetadata?.Arn;
    if (!otherArn) throw new Error("LocalStack second CreateKey returned no ARN");

    const primaryProv = new KmsKeyProvider({
      keyArn: cmkArn,
      region: REGION,
      endpoint: ENDPOINT,
      client,
    });
    const { ciphertext, fingerprint } = await primaryProv.encryptCurrent("secret");

    // Provider pointed at a DIFFERENT CMK must refuse this fingerprint via
    // our pre-flight fingerprint check (before even talking to KMS).
    const otherProv = new KmsKeyProvider({
      keyArn: otherArn,
      region: REGION,
      endpoint: ENDPOINT,
      client,
    });
    expect(otherProv.decrypt(ciphertext, fingerprint)).rejects.toThrow(
      /KMS key mismatch/
    );
  });
});
