/**
 * v0.6.7 — auto-fallback when a baseline-rewritten model 4xxs upstream.
 *
 * Motivating failure: a baseline policy rewrote a provider-specific model id
 * to a stale generic model id. Upstream returned `Unknown model`, so the
 * caller saw a hard failure even though their original requested model was
 * valid. Right behavior: when the rewritten model 4xxs with a "model is the
 * problem" pattern, retry ONCE with the caller's original model.
 *
 * This file pins:
 *   (a) the regex-based detector identifies real-world model-invalid
 *       4xx shapes from each major provider
 *   (b) the detector REJECTS legitimate 4xxs (content-policy,
 *       malformed messages, auth) so we don't retry-amplify those
 *   (c) the env opt-out flag works
 *   (d) the auto-fallback fires the second upstream call AND the
 *       row in `requests` is tagged for operator visibility (covered
 *       by the e2e-style integration once Postgres is reachable;
 *       see failed-request-observability.test.ts for the env handling
 *       pattern)
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  isRewriteFailure4xx,
  rewriteFallbackEnabled,
} from "../src/failover";

const originalEnv = { ...process.env };

afterEach(() => {
  // Restore env after each test so flag toggling doesn't leak.
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    process.env[k] = v;
  }
});

describe("isRewriteFailure4xx — detector", () => {
  describe("matches real-world model-invalid 4xx shapes", () => {
    test("OpenAI: `model_not_found` shape", () => {
      const body = {
        error: {
          message:
            "The model `gpt-5.2` does not exist or you do not have access to it.",
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      };
      expect(isRewriteFailure4xx(404, body)).toBe(true);
      expect(isRewriteFailure4xx(400, body)).toBe(true);
    });

    test("OpenAI-compatible proxy: bare `Unknown model` 400", () => {
      // Proxy failure body, simplified.
      const body = {
        error: {
          message: "Unknown model: gpt-5.2",
          type: "invalid_request_error",
        },
      };
      expect(isRewriteFailure4xx(400, body)).toBe(true);
    });

    test("Anthropic: `model is not a recognized` shape", () => {
      const body = {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "model: claude-99 is not a recognized model. See https://docs.anthropic.com/en/docs/models",
        },
      };
      expect(isRewriteFailure4xx(400, body)).toBe(true);
    });

    test("DeepSeek-style: `Invalid model` 400", () => {
      const body = {
        error: {
          message: "Invalid model id: deepseek-coder-v3",
          type: "invalid_request_error",
        },
      };
      expect(isRewriteFailure4xx(400, body)).toBe(true);
    });

    test("404 Not Found from a provider that returns 404 instead of 400", () => {
      // Some BYO endpoints return 404 for unknown model paths
      // (vLLM, custom OpenAI-compat proxies).
      const body = { detail: "Model gpt-99 not found in the catalog" };
      expect(isRewriteFailure4xx(404, body)).toBe(true);
    });

    test("body that's a plain string (some upstreams return text/plain on error)", () => {
      const body = "Model is not supported on this endpoint.";
      expect(isRewriteFailure4xx(400, body)).toBe(true);
    });

    test("OpenAI-compatible proxy 401 `key_model_access_denied`", () => {
      // Some OpenAI-compatible proxies return 401 when the requested model
      // isn't in the API key's allowlist. The user's intent is unambiguous:
      // the key is valid for other models, the routed name just isn't in that
      // allowlist, so retrying with the original model is correct.
      const body = {
        error: {
          code: "401",
          type: "key_model_access_denied",
          param: "model",
          message:
            "key not allowed to access model. This key can only access models=['default-models']. Tried to access provider/gpt-this-doesnt-exist",
        },
      };
      expect(isRewriteFailure4xx(401, body)).toBe(true);
    });

    test("403 `model access denied` shape from a hypothetical hosted plan limit", () => {
      // E.g. Anthropic / OpenAI tier-gated models that surface as 403
      // when the caller's plan doesn't include that model. Same
      // diagnosis: model mismatch, not key auth → fallback to
      // caller's original model is correct.
      const body = {
        error: { message: "Model claude-opus-4 is not available on your plan; access denied." },
      };
      expect(isRewriteFailure4xx(403, body)).toBe(true);
    });
  });

  describe("REJECTS legitimate 4xxs (don't retry-amplify these)", () => {
    test("malformed-messages 400 (no `model` mention)", () => {
      const body = {
        error: {
          message: "messages: must be an array of objects",
          type: "invalid_request_error",
          param: "messages",
        },
      };
      expect(isRewriteFailure4xx(400, body)).toBe(false);
    });

    test("content-policy 400 (no model-shape keywords)", () => {
      const body = {
        error: {
          message:
            "Your request was rejected as a result of our safety system.",
          type: "content_policy_violation",
          code: "content_filter",
        },
      };
      expect(isRewriteFailure4xx(400, body)).toBe(false);
    });

    test("temperature-out-of-range 400 (mentions `invalid` but not `model`)", () => {
      const body = {
        error: {
          message: "Invalid value for 'temperature': must be in [0, 2]",
          type: "invalid_request_error",
          param: "temperature",
        },
      };
      expect(isRewriteFailure4xx(400, body)).toBe(false);
    });

    test("401 unauthorized — pure auth failure (no `model` mention) STAYS rejected", () => {
      const body = {
        error: { message: "Invalid API key", code: "invalid_api_key" },
      };
      // The "model" gate is what keeps generic auth failures out of
      // the retry path: this body never mentions "model" → not a
      // rewrite-failure shape → don't retry. Trying a different model
      // name with the same broken key would compound the failure.
      expect(isRewriteFailure4xx(401, body)).toBe(false);
    });

    test("403 — pure auth failure (no `model` mention) STAYS rejected", () => {
      const body = { error: { message: "Forbidden: rate-limit reached" } };
      expect(isRewriteFailure4xx(403, body)).toBe(false);
    });

    test("5xx upstream errors are not in scope (already covered by transient retry)", () => {
      const body = { error: { message: "Internal server error" } };
      expect(isRewriteFailure4xx(500, body)).toBe(false);
      expect(isRewriteFailure4xx(503, body)).toBe(false);
    });

    test("null / empty body never matches", () => {
      expect(isRewriteFailure4xx(400, null)).toBe(false);
      expect(isRewriteFailure4xx(400, undefined)).toBe(false);
      expect(isRewriteFailure4xx(400, "")).toBe(false);
    });

    test("body with `model` mentioned but no failure-shape keyword", () => {
      // Hypothetical: upstream reports a successful diagnostic
      // about model usage — we should NOT confuse it with a failure.
      const body = { warning: "model gpt-5.2 has high latency today" };
      // Doesn't match any of {not found, invalid, unknown, does not exist,
      // no such, not supported, not_found} → stays false.
      expect(isRewriteFailure4xx(400, body)).toBe(false);
    });
  });

  describe("circular reference defense", () => {
    test("non-serializable body returns false (don't retry on parse failures)", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      // Should not throw; should return false (we can't decide, so
      // play it safe and let the original 4xx surface).
      expect(() => isRewriteFailure4xx(400, circular)).not.toThrow();
      expect(isRewriteFailure4xx(400, circular)).toBe(false);
    });
  });
});

describe("rewriteFallbackEnabled — env opt-out", () => {
  test("default ON (no env var set)", () => {
    delete process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED;
    expect(rewriteFallbackEnabled()).toBe(true);
  });

  test('`"0"` disables', () => {
    process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED = "0";
    expect(rewriteFallbackEnabled()).toBe(false);
  });

  test('`"false"` (any case) disables', () => {
    process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED = "false";
    expect(rewriteFallbackEnabled()).toBe(false);
    process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED = "FALSE";
    expect(rewriteFallbackEnabled()).toBe(false);
  });

  test('`"1"` keeps it on (explicit enable)', () => {
    process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED = "1";
    expect(rewriteFallbackEnabled()).toBe(true);
  });

  test('any other value (e.g. `"true"`) keeps it on (don\'t want fallback to silently turn off)', () => {
    process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED = "true";
    expect(rewriteFallbackEnabled()).toBe(true);
    process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED = "yes";
    expect(rewriteFallbackEnabled()).toBe(true);
  });
});
