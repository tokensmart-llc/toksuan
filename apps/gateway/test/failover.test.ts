import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// We import lazily inside each test so we can manipulate env vars
// (the failover module caches map parsing on first call).

const ENV_KEYS = [
  "TOKENSMART_FAILOVER_MAP",
  "TOKENSMART_RETRY_MAX_ATTEMPTS",
  "TOKENSMART_RETRY_BASE_DELAY_MS",
];

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  // Bun's module cache prevents reloading. Reset by deleting from
  // require.cache equivalent — Bun supports `import.meta.require.cache`
  // but the simpler tactic is to import dynamically with a cache-buster.
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("failover module", () => {
  test("isRetryableStatus classifies 5xx and 408/425/429 as retryable", async () => {
    const { isRetryableStatus } = await import(
      `../src/failover.ts?test=${Date.now()}-1`
    );
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(425)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(600)).toBe(false);
  });

  test("isRetryableError catches network-level codes from err.code or err.cause.code", async () => {
    const { isRetryableError } = await import(
      `../src/failover.ts?test=${Date.now()}-2`
    );
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError("oops")).toBe(false);

    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isRetryableError({ cause: { code: "UND_ERR_SOCKET" } })).toBe(true);
    expect(
      isRetryableError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })
    ).toBe(true);

    // Aborted requests should NOT be retried — caller bailed deliberately
    expect(isRetryableError({ name: "AbortError", code: "ABORT_ERR" })).toBe(
      false
    );

    // Random unknown error → not retryable, fail loud
    expect(isRetryableError({ code: "EUNKNOWN" })).toBe(false);
    expect(isRetryableError({})).toBe(false);
  });

  test("backoffDelayMs respects base + 2^attempt with full jitter, capped at 5s", async () => {
    const { backoffDelayMs } = await import(
      `../src/failover.ts?test=${Date.now()}-3`
    );
    // attempt 0 → 0..base
    for (let i = 0; i < 100; i++) {
      const d = backoffDelayMs(0, 200);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(200);
    }
    // attempt 5 → 0..min(200*32, 5000) = 0..5000
    for (let i = 0; i < 100; i++) {
      const d = backoffDelayMs(5, 200);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(5000);
    }
  });

  test("getFailoverMap parses key=>value pairs, tolerates whitespace and empty entries", async () => {
    process.env.TOKENSMART_FAILOVER_MAP =
      "gpt-4o=>claude-3-5-sonnet-latest, gpt-4o-mini =>  claude-3-5-haiku-latest ,,foo=>bar";
    const { getFailoverMap } = await import(
      `../src/failover.ts?test=${Date.now()}-4`
    );
    const m = getFailoverMap();
    expect(m.size).toBe(3);
    expect(m.get("gpt-4o")).toBe("claude-3-5-sonnet-latest");
    expect(m.get("gpt-4o-mini")).toBe("claude-3-5-haiku-latest");
    expect(m.get("foo")).toBe("bar");
  });

  test("getFailoverMap returns an empty map when env var is unset/empty", async () => {
    const { getFailoverMap } = await import(
      `../src/failover.ts?test=${Date.now()}-5`
    );
    expect(getFailoverMap().size).toBe(0);
  });

  test("lookupFailover returns null for non-mapped models", async () => {
    process.env.TOKENSMART_FAILOVER_MAP = "gpt-4o=>claude-3-5-sonnet-latest";
    const { lookupFailover } = await import(
      `../src/failover.ts?test=${Date.now()}-6`
    );
    expect(lookupFailover("gpt-4o")).toBe("claude-3-5-sonnet-latest");
    expect(lookupFailover("gpt-3.5-turbo")).toBe(null);
  });

  test("getRetryMaxAttempts and getRetryBaseDelayMs use defaults when unset", async () => {
    const { getRetryMaxAttempts, getRetryBaseDelayMs } = await import(
      `../src/failover.ts?test=${Date.now()}-7`
    );
    expect(getRetryMaxAttempts()).toBe(2);
    expect(getRetryBaseDelayMs()).toBe(200);
  });

  test("getRetryMaxAttempts honors env override", async () => {
    process.env.TOKENSMART_RETRY_MAX_ATTEMPTS = "5";
    const { getRetryMaxAttempts } = await import(
      `../src/failover.ts?test=${Date.now()}-8`
    );
    expect(getRetryMaxAttempts()).toBe(5);
  });

  test("getRetryMaxAttempts falls back to default for non-finite or negative", async () => {
    process.env.TOKENSMART_RETRY_MAX_ATTEMPTS = "not-a-number";
    const { getRetryMaxAttempts } = await import(
      `../src/failover.ts?test=${Date.now()}-9`
    );
    expect(getRetryMaxAttempts()).toBe(2);
  });
});
