/**
 * Semantic cache tests — exact-match path. Similarity-layer is exercised
 * end-to-end indirectly (via `quality.ts` reading TOKENSMART_QUALITY_*
 * env vars) but unit-tested here only at the eligibility-gate level.
 *
 * These tests intentionally do NOT touch Postgres — `semantic-cache.ts`
 * is in-memory by design.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetSemanticCache,
  _testInternals,
  lookupSemanticCache,
  storeInSemanticCache,
} from "../src/semantic-cache";

const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "22222222-2222-2222-2222-222222222222";

function envSnapshot(): Record<string, string | undefined> {
  return {
    TOKENSMART_CACHE_ENABLED: process.env.TOKENSMART_CACHE_ENABLED,
    TOKENSMART_CACHE_MAX_ENTRIES: process.env.TOKENSMART_CACHE_MAX_ENTRIES,
    TOKENSMART_CACHE_TTL_SECONDS: process.env.TOKENSMART_CACHE_TTL_SECONDS,
    TOKENSMART_CACHE_SIMILARITY_THRESHOLD:
      process.env.TOKENSMART_CACHE_SIMILARITY_THRESHOLD,
  };
}
function envRestore(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const cacheableBody = {
  model: "gpt-4o-mini",
  temperature: 0,
  messages: [
    { role: "user", content: "What is the capital of France? Be terse." },
  ],
};

const fakeUpstreamResponse = {
  id: "chatcmpl-test",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Paris." },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 0 },
  },
};

describe("semantic-cache: eligibility gate", () => {
  test("rejects streaming requests", () => {
    const reason = _testInternals.notCacheable({
      ...cacheableBody,
      stream: true,
    });
    expect(reason).toBe("streaming");
  });

  test("rejects non-zero temperature", () => {
    expect(
      _testInternals.notCacheable({ ...cacheableBody, temperature: 0.7 })
    ).toBe("non_zero_temperature");
    // Missing temperature → also rejected (we require explicit 0).
    const noTemp = { model: "x", messages: cacheableBody.messages };
    expect(_testInternals.notCacheable(noTemp)).toBe("non_zero_temperature");
  });

  test("rejects requests with tools", () => {
    expect(
      _testInternals.notCacheable({
        ...cacheableBody,
        tools: [{ type: "function", function: { name: "x" } }],
      })
    ).toBe("tools_present");
  });

  test("rejects empty / trivially-short prompts", () => {
    expect(
      _testInternals.notCacheable({
        ...cacheableBody,
        messages: [],
      })
    ).toBe("no_messages");
    expect(
      _testInternals.notCacheable({
        ...cacheableBody,
        messages: [{ role: "user", content: "hi" }],
      })
    ).toBe("prompt_too_short");
  });

  test("accepts a sane request body", () => {
    expect(_testInternals.notCacheable(cacheableBody)).toBeNull();
  });
});

describe("semantic-cache: exact-key stability", () => {
  test("key is stable across object key reorder", () => {
    const a = _testInternals.exactKey(PROJECT_A, {
      ...cacheableBody,
      max_tokens: 50,
    });
    const reordered = {
      max_tokens: 50,
      messages: cacheableBody.messages,
      temperature: 0,
      model: "gpt-4o-mini",
    };
    const b = _testInternals.exactKey(PROJECT_A, reordered);
    expect(a).toBe(b);
  });

  test("different projects produce different keys for the same body", () => {
    const a = _testInternals.exactKey(PROJECT_A, cacheableBody);
    const b = _testInternals.exactKey(PROJECT_B, cacheableBody);
    expect(a).not.toBe(b);
  });

  test("model swap changes the key", () => {
    const a = _testInternals.exactKey(PROJECT_A, cacheableBody);
    const b = _testInternals.exactKey(PROJECT_A, {
      ...cacheableBody,
      model: "claude-3-5-haiku-latest",
    });
    expect(a).not.toBe(b);
  });
});

describe("semantic-cache: lookup + store integration", () => {
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = envSnapshot();
    process.env.TOKENSMART_CACHE_ENABLED = "1";
    process.env.TOKENSMART_CACHE_MAX_ENTRIES = "32";
    process.env.TOKENSMART_CACHE_TTL_SECONDS = "60";
    delete process.env.TOKENSMART_CACHE_SIMILARITY_THRESHOLD;
    _resetSemanticCache();
  });
  afterEach(() => {
    _resetSemanticCache();
    envRestore(snap);
  });

  test("first lookup misses, store, second lookup hits", async () => {
    const first = await lookupSemanticCache(PROJECT_A, cacheableBody);
    expect(first.hit).toBe(false);
    if (first.hit) return;
    expect(first.cacheKey).not.toBeNull();
    if (!first.cacheKey) return;

    await storeInSemanticCache({
      projectId: PROJECT_A,
      cacheKey: first.cacheKey,
      body: cacheableBody,
      responseBody: fakeUpstreamResponse,
    });

    const second = await lookupSemanticCache(PROJECT_A, cacheableBody);
    expect(second.hit).toBe(true);
    if (!second.hit) return;
    expect(second.kind).toBe("exact");
    expect(second.responseBody).toEqual(fakeUpstreamResponse);
    expect(second.inputTokens).toBe(12);
    expect(second.outputTokens).toBe(1);
  });

  test("tenant isolation: project A's cache does not satisfy project B", async () => {
    const aMiss = await lookupSemanticCache(PROJECT_A, cacheableBody);
    if (!aMiss.cacheKey) throw new Error("expected cacheKey");
    await storeInSemanticCache({
      projectId: PROJECT_A,
      cacheKey: aMiss.cacheKey,
      body: cacheableBody,
      responseBody: fakeUpstreamResponse,
    });
    const bLookup = await lookupSemanticCache(PROJECT_B, cacheableBody);
    expect(bLookup.hit).toBe(false);
  });

  test("lookup of streaming/ineligible request returns reason, no key", async () => {
    const r = await lookupSemanticCache(PROJECT_A, {
      ...cacheableBody,
      stream: true,
    });
    expect(r.hit).toBe(false);
    if (!r.hit) {
      expect(r.cacheKey).toBeNull();
      expect(r.reason).toBe("streaming");
    }
  });

  test("disabled by default: lookup with no env returns disabled reason", async () => {
    delete process.env.TOKENSMART_CACHE_ENABLED;
    _resetSemanticCache();
    const r = await lookupSemanticCache(PROJECT_A, cacheableBody);
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.reason).toBe("disabled");
  });
});
