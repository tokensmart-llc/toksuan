/**
 * v0.6.4 — guard against the "silent unknown-model rewrite" footgun.
 *
 * Pre-v0.6.4: a request with `model="grok-2-latest"` (no provider
 * template, not in any policy bucket) hit `applyBaselineRouting`,
 * which used `bucket.max_quality` as the quality anchor and then
 * picked the cheapest within-eps frontier model. The user thought
 * they were calling xAI, the gateway 200'd with a Gemini reply, and
 * the L5 `ops_model_rejections` table never saw `grok-2-latest`
 * because the silent rewrite preempted `resolveProvider`'s
 * `no_template` branch. Both bad: surprise model swap for the
 * caller, blind spot for the operator.
 *
 * Post-v0.6.4: unknown caller models (no built-in template AND not
 * in any active-policy bucket) bail out of baseline routing with
 * `applied: false, reason: "unknown_caller_model"`. The request
 * flows through to `resolveProvider`, which 400s with `no_template`
 * + stamps the L5 telemetry row.
 *
 * These tests pin the new contract.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Env must be set BEFORE importing src/router (transitively imports
// src/config which validates + exits on missing creds at module init).
// Bun executes the top-level statements in import order, so this MUST
// run before the dynamic import below.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? ":memory:";
// Any one of the supported keys satisfies the "at least one upstream
// is configured" check. Safe placeholder — we never make a real call
// in this file; we only exercise the in-memory routing decision.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";
process.env.TOKENSMART_BASELINE_POLICY_ENABLED = "1";
const policyPath = path.join(
  mkdtempSync(path.join(tmpdir(), "tokensmart-policy-")),
  "baseline-policy.json"
);
const testBucket = {
  task_type: "chat",
  complexity: "simple",
  models: [
    {
      model: "fixture/benchmarked-model",
      provider: "fixture",
      avg_cost_micro_cents: 1,
      avg_input_tokens: 1,
      avg_output_tokens: 1,
      quality_score: 0.9,
      n: 1,
    },
    {
      model: "gpt-4o-mini",
      provider: "openai",
      avg_cost_micro_cents: 2,
      avg_input_tokens: 1,
      avg_output_tokens: 1,
      quality_score: 0.91,
      n: 1,
    },
  ],
  max_quality: 0.91,
};
writeFileSync(
  policyPath,
  JSON.stringify({
    version: "test-public",
    generated_at: new Date(0).toISOString(),
    benchmarks: ["fixture"],
    judge_model: null,
    default_eps: 0.05,
    buckets: [testBucket],
    lookup: { "chat:simple": testBucket },
  })
);
process.env.TOKENSMART_BASELINE_POLICY_PATH = policyPath;

import { describe, expect, test } from "bun:test";
import type { OpenAIChatRequest } from "../src/providers/openai";

const { applyBaselineRouting } = await import("../src/router");

describe("v0.6.4 baseline routing — refuse rewrite on unknown caller model", () => {
  test("unknown caller model (no template, not in bucket) is NOT rewritten — passes through to resolveProvider for a clean 400 + L5 telemetry", async () => {
    // grok-2-latest matches NO built-in provider template
    // (PROVIDER_TEMPLATES regexes all anchor on a known provider prefix)
    // AND is absent from the test baseline-policy buckets.
    const body: OpenAIChatRequest = {
      model: "grok-2-latest",
      messages: [{ role: "user", content: "hello" }],
    };
    const decision = await applyBaselineRouting(null, body, null);

    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("unknown_caller_model");
    // Critical: body.model MUST stay untouched so the downstream
    // resolveProvider sees `grok-2-latest` and emits no_template.
    expect(body.model).toBe("grok-2-latest");
  });

  test("garbage / placeholder model name also bails out (was already caught pre-fix; pin the behavior)", async () => {
    // Pre-fix this returned `no_cheaper:...` (rescue-anchor was
    // bucket.max_quality but no within-eps cheaper model existed
    // for the random task classification). Post-fix it returns
    // unknown_caller_model — same end-user effect (request 400s
    // downstream), but the reason string is now diagnostic instead
    // of misleading.
    const body: OpenAIChatRequest = {
      model: "random-test-model-xyz-???",
      messages: [{ role: "user", content: "hi" }],
    };
    const decision = await applyBaselineRouting(null, body, null);
    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("unknown_caller_model");
    expect(body.model).toBe("random-test-model-xyz-???");
  });

  test("model whose name matches a built-in provider template (gpt-) is NOT bailed — eligible for normal baseline rewrite", async () => {
    // gpt-9999 matches the OpenAI prefix regex /^(gpt-|o1-|...)/i
    // — the gateway can in principle route this to OpenAI (will
    // 404 upstream if the model doesn't exist there, but that's
    // OpenAI's job, not ours). Baseline routing should treat this
    // as "known caller" and either downgrade (if a within-eps
    // cheaper model exists for the resolved bucket) or no-op.
    // Either way: reason MUST NOT be `unknown_caller_model`.
    const body: OpenAIChatRequest = {
      model: "gpt-9999-imaginary",
      messages: [{ role: "user", content: "hello" }],
    };
    const decision = await applyBaselineRouting(null, body, null);
    expect(decision.reason).not.toBe("unknown_caller_model");
  });

  test("baseline skips an uncallable cheaper recommendation and picks a callable fallback", async () => {
    const body: OpenAIChatRequest = {
      model: "gpt-9999-imaginary",
      messages: [{ role: "user", content: "hello" }],
    };

    const decision = await applyBaselineRouting(null, body, null);

    expect(decision.applied).toBe(true);
    expect(body.model).toBe("gpt-4o-mini");
  });

  test("baseline leaves the request unchanged when no cheaper callable recommendation remains", async () => {
    const body: OpenAIChatRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    };

    const decision = await applyBaselineRouting(null, body, null);

    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("no_callable_cheaper:chat:simple");
    expect(body.model).toBe("gpt-4o-mini");
  });

  test("model whose name appears in a policy bucket is NOT bailed — eligible for normal anchor-on-its-own-quality logic", async () => {
    // Models inside the active baseline-policy buckets are
    // by definition known — we have benchmark numbers for them.
    // Even though this fixture model has no dedicated provider
    // template, the bucket-membership check is the second acceptance gate.
    const body: OpenAIChatRequest = {
      model: "fixture/benchmarked-model",
      messages: [{ role: "user", content: "hi" }],
    };
    const decision = await applyBaselineRouting(null, body, null);
    // Eligible model — we may end up with `applied:true` (if a
    // cheaper within-eps model exists in the bucket) OR with
    // `applied:false, reason: "no_cheaper:..."`. Both are valid.
    // The fix is: NOT `unknown_caller_model`.
    expect(decision.reason).not.toBe("unknown_caller_model");
  });
});
