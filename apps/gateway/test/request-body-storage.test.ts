/**
 * v0.6.7 — selective `requests.request_body` storage.
 *
 * Pre-v0.6.7 every request stored the full JSON wire body in
 * `requests.request_body`. Debugging gold but ~10× row size + a real
 * privacy concern (full prompts pinned in Postgres forever). The new
 * env knob TOKENSMART_STORE_FULL_REQUEST_BODY trades debug visibility
 * for storage cost + privacy posture:
 *
 *   sample (default) — failures keep full body, successes sample 1%
 *   never            — never store full body, ever
 *   always           — store full body always (legacy behavior)
 *
 * This file pins the contract:
 *   (a) the env-var parser handles default + valid + invalid values
 *   (b) the policy rules (sample = failure-full + 1% success-sample,
 *       never = always summary, always = always full) are correct
 *   (c) the summary stub preserves enough structural shape for
 *       traffic-pattern debugging without keeping prompt content
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chooseRequestBodyForStorage,
  getRequestBodyStorageMode,
  summarizeRequestBody,
  type TruncatedRequestBody,
} from "../src/request-body-storage";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    process.env[k] = v;
  }
});

describe("getRequestBodyStorageMode — env parsing", () => {
  test("default is 'sample' (no env var set)", () => {
    delete process.env.TOKENSMART_STORE_FULL_REQUEST_BODY;
    expect(getRequestBodyStorageMode()).toBe("sample");
  });

  test("'never' / 'always' / 'sample' all parse to themselves", () => {
    process.env.TOKENSMART_STORE_FULL_REQUEST_BODY = "never";
    expect(getRequestBodyStorageMode()).toBe("never");
    process.env.TOKENSMART_STORE_FULL_REQUEST_BODY = "always";
    expect(getRequestBodyStorageMode()).toBe("always");
    process.env.TOKENSMART_STORE_FULL_REQUEST_BODY = "sample";
    expect(getRequestBodyStorageMode()).toBe("sample");
  });

  test("case + whitespace are normalized", () => {
    process.env.TOKENSMART_STORE_FULL_REQUEST_BODY = " NEVER ";
    expect(getRequestBodyStorageMode()).toBe("never");
    process.env.TOKENSMART_STORE_FULL_REQUEST_BODY = "Always";
    expect(getRequestBodyStorageMode()).toBe("always");
  });

  test("unknown values fall back to default 'sample' (not a hard fail at hot path)", () => {
    process.env.TOKENSMART_STORE_FULL_REQUEST_BODY = "yolo";
    expect(getRequestBodyStorageMode()).toBe("sample");
    process.env.TOKENSMART_STORE_FULL_REQUEST_BODY = "1";
    expect(getRequestBodyStorageMode()).toBe("sample");
  });
});

describe("summarizeRequestBody — structural stub", () => {
  test("preserves model + message_count + tools_count", () => {
    const stub = summarizeRequestBody(
      {
        model: "gpt-5.2",
        messages: [
          { role: "system", content: "..." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
        tools: [{ type: "function", function: { name: "foo" } }],
      },
      "sample"
    );
    expect(stub.truncated).toBe(true);
    expect(stub.model).toBe("gpt-5.2");
    expect(stub.message_count).toBe(3);
    expect(stub.tools_count).toBe(1);
  });

  test("missing fields default cleanly", () => {
    const stub = summarizeRequestBody({}, "sample");
    expect(stub.model).toBe("");
    expect(stub.message_count).toBe(0);
    expect(stub.tools_count).toBe(0);
  });

  test("reason reflects the active mode", () => {
    expect(summarizeRequestBody({ model: "x" }, "sample").reason).toBe(
      "sampled_out"
    );
    expect(summarizeRequestBody({ model: "x" }, "never").reason).toBe(
      "storage_disabled"
    );
  });

  test("non-array messages / tools default to count 0 (safety against weird inputs)", () => {
    const stub = summarizeRequestBody(
      {
        model: "x",
        messages: "not an array",
        tools: { wrong: "shape" },
      },
      "sample"
    );
    expect(stub.message_count).toBe(0);
    expect(stub.tools_count).toBe(0);
  });
});

describe("chooseRequestBodyForStorage — policy router", () => {
  const sampleBody = {
    model: "gpt-5.2",
    messages: [{ role: "user", content: "hi" }],
  };

  test("'always' mode returns full body for any status", () => {
    expect(chooseRequestBodyForStorage(sampleBody, "success", "always")).toBe(
      sampleBody
    );
    expect(chooseRequestBodyForStorage(sampleBody, "error", "always")).toBe(
      sampleBody
    );
  });

  test("'never' mode returns the summary stub for any status (including failures)", () => {
    const onSuccess = chooseRequestBodyForStorage(
      sampleBody,
      "success",
      "never"
    );
    expect((onSuccess as TruncatedRequestBody).truncated).toBe(true);
    expect((onSuccess as TruncatedRequestBody).reason).toBe("storage_disabled");
    // Failures also get truncated under 'never' — the operator who set
    // 'never' explicitly opted out of body storage. Surprise-keeping
    // bodies for failures would violate their privacy posture.
    const onError = chooseRequestBodyForStorage(sampleBody, "error", "never");
    expect((onError as TruncatedRequestBody).truncated).toBe(true);
    expect((onError as TruncatedRequestBody).reason).toBe("storage_disabled");
  });

  test("'sample' mode keeps full body on every non-success status", () => {
    // Each failure mode must keep the full body so the operator has the
    // wire dump for debugging.
    for (const status of [
      "error",
      "loop_detected",
      "budget_exceeded",
      "plan_limit_exceeded",
      "timeout",
    ]) {
      expect(chooseRequestBodyForStorage(sampleBody, status, "sample")).toBe(
        sampleBody
      );
    }
  });

  test("'sample' mode on success returns truncated stub MOST of the time (1% sample)", () => {
    // Run a large enough trial that "always full" or "always truncated"
    // would be statistically impossible. The expected ratio is ~99%
    // truncated. Allow a generous margin so this isn't flaky.
    let truncatedCount = 0;
    let fullCount = 0;
    const trials = 2_000;
    for (let i = 0; i < trials; i++) {
      const out = chooseRequestBodyForStorage(sampleBody, "success", "sample");
      if (out === sampleBody) {
        fullCount++;
      } else {
        truncatedCount++;
      }
    }
    // At 1% sample rate over 2000 trials, expected ~20 full-body
    // returns. Allow [0, 100] for jitter (3-sigma is ~14, so 100 is
    // unimaginably loose — picked to never flake).
    expect(fullCount).toBeLessThan(100);
    expect(truncatedCount).toBeGreaterThan(1900);
  });

  test("null / undefined body is passed through unchanged (safety against missing input)", () => {
    expect(chooseRequestBodyForStorage(null, "success", "sample")).toBe(null);
    expect(chooseRequestBodyForStorage(undefined, "success", "sample")).toBe(
      undefined
    );
  });
});
