import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../src/config";
import { tryUpstreamWithRetries } from "../src/routes/chat";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function provider(baseUrl: string): ProviderConfig {
  return {
    name: "openai",
    apiKey: "test-key",
    baseUrl,
    matches: () => true,
  };
}

describe("chat retry wrapper", () => {
  test("exhausted retryable HTTP statuses return failure so failover can run", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json(
          { error: { message: "temporary upstream failure" } },
          { status: 500 }
      );
    }) as typeof fetch;

    const result = await tryUpstreamWithRetries({
      body: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      },
      providerCfg: provider("http://tokensmart.test/v1"),
      totalAttempts: 2,
      baseDelay: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("HTTP 500");
      expect(result.attempts).toBe(2);
    }
    expect(calls).toBe(2);
  });
});
