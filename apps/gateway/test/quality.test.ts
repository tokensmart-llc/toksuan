import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";
process.env.TOKENSMART_QUALITY_EMBED_MODEL = "text-embedding-test";
process.env.TOKENSMART_QUALITY_EMBED_BASE_URL = "https://example.test/v1";

const { embedTexts, _testInternals } = await import("../src/quality");

const originalFetch = globalThis.fetch;

describe("embedTexts index alignment", () => {
  let sentInputs: string[] = [];

  beforeEach(() => {
    sentInputs = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      sentInputs = Array.isArray(body.input) ? body.input : [];
      // Echo back a distinct unit vector per input so we can tell them apart.
      return new Response(
        JSON.stringify({
          data: sentInputs.map((_, i) => ({ embedding: [i + 1, 0, 0] })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns one embedding per input, 1:1 with the input order", async () => {
    const out = await embedTexts(["alpha", "beta"]);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.length).toBe(2);
    expect(out[0]).toEqual([1, 0, 0]);
    expect(out[1]).toEqual([2, 0, 0]);
  });

  test("empty inputs are not sent but keep their slot as []", async () => {
    const out = await embedTexts(["", "real", "   "]);
    expect(out).not.toBeNull();
    if (!out) return;
    // Only the non-empty string was actually embedded.
    expect(sentInputs).toEqual(["real"]);
    // Index alignment preserved: empties become [] placeholders.
    expect(out.length).toBe(3);
    expect(out[0]).toEqual([]);
    expect(out[1]).toEqual([1, 0, 0]);
    expect(out[2]).toEqual([]);
  });

  test("all-empty input returns null (nothing embeddable)", async () => {
    const out = await embedTexts(["", "  "]);
    expect(out).toBeNull();
  });

  test("cosineSimilarity treats a placeholder [] as no match (0)", () => {
    expect(_testInternals.cosineSimilarity([], [1, 0, 0])).toBe(0);
  });
});
