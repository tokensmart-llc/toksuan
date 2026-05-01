import { describe, expect, test } from "bun:test";
import { estimateChatCostMicroCents } from "../src/budget";

describe("budget cost estimation", () => {
  test("uses explicit max_tokens when reserving headroom", () => {
    const estimate = estimateChatCostMicroCents("openai", "gpt-4o-mini", {
      model: "gpt-4o-mini",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(estimate.estimated_output_tokens).toBe(100);
    expect(estimate.estimated_input_tokens).toBeGreaterThan(0);
    expect(estimate.estimated_micro_cents).toBeGreaterThan(0);
    expect(estimate.pricing_basis).toBe("exact");
  });

  test("defaults missing max_tokens to a conservative output reservation", () => {
    const estimate = estimateChatCostMicroCents("openai", "gpt-4o-mini", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(estimate.estimated_output_tokens).toBe(4096);
    expect(estimate.estimated_micro_cents).toBeGreaterThan(0);
    expect(estimate.pricing_basis).toBe("exact");
  });

  test("unknown model on a known provider falls back to family_max + safety multiplier (was: silently 0, bypassing budget)", () => {
    // Critical bug class: a brand-new model name OpenAI ships tomorrow
    // would, under the old code, return estimated_micro_cents = 0,
    // which means reservations of 0 = no gating at all. We'd run
    // straight through the budget check until the actual cost landed
    // post-finalize. Family_max + safety multiplier guarantees we
    // ALWAYS pre-deduct something pessimistic.
    const estimate = estimateChatCostMicroCents(
      "openai",
      "some-unreleased-gpt-model",
      {
        model: "some-unreleased-gpt-model",
        max_tokens: 1000,
        messages: [{ role: "user", content: "hello" }],
      }
    );

    expect(estimate.pricing_basis).toBe("family_max");
    // Provider's most expensive model (o1-preview at $15 in / $60 out per
    // M tokens) times 1.5x safety. 1000 output tokens alone would be at
    // least ~9000 micro_cents (1000 * 60 * 1.5 * 100 / 1M = 9_000) before
    // input/cached. Asserting "> 5000" is the safety-floor sanity check.
    expect(estimate.estimated_micro_cents).toBeGreaterThan(5000);
  });

  test("unknown provider entirely falls back to global_max", () => {
    const estimate = estimateChatCostMicroCents(
      // Cast: passing null on purpose to model "we couldn't even
      // resolve a provider" — happens when a request hits a model
      // string that doesn't match any provider regex.
      null as unknown as "openai",
      "totally-unknown-model",
      {
        model: "totally-unknown-model",
        max_tokens: 500,
        messages: [{ role: "user", content: "hi" }],
      }
    );
    expect(estimate.pricing_basis).toBe("global_max");
    expect(estimate.estimated_micro_cents).toBeGreaterThan(0);
  });
});
