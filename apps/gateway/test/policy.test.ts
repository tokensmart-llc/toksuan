import { describe, expect, test } from "bun:test";
import { recommendModel, type BaselinePolicy } from "../src/policy";

function policy(): BaselinePolicy {
  return {
    version: "test",
    generated_at: new Date(0).toISOString(),
    benchmarks: ["unit"],
    judge_model: null,
    default_eps: 0.05,
    buckets: [
      {
        task_type: "reasoning",
        complexity: "medium",
        max_quality: 1,
        models: [
          {
            model: "cheap-reasoner",
            provider: "openai",
            avg_cost_micro_cents: 10,
            avg_input_tokens: 10,
            avg_output_tokens: 10,
            quality_score: 0.98,
            n: 20,
          },
          {
            model: "frontier-reasoner",
            provider: "openai",
            avg_cost_micro_cents: 100,
            avg_input_tokens: 10,
            avg_output_tokens: 10,
            quality_score: 1,
            n: 20,
          },
        ],
      },
    ],
    lookup: {},
  };
}

describe("baseline policy", () => {
  test("tool_use falls back to reasoning buckets with strict tool_use eps", () => {
    const p = policy();
    p.lookup["reasoning:medium"] = p.buckets[0]!;

    const rec = recommendModel(
      p,
      "tool_use",
      "medium",
      "frontier-reasoner",
      0.05
    );

    expect(rec?.recommended).toBe("cheap-reasoner");
    expect(rec?.task_type).toBe("tool_use");
    expect(rec?.reason).toContain("tool_use:medium→reasoning:medium");
    expect(rec?.reason).toContain("eps=0.05");
  });

  test("chat:hard does not fall back to cheaper medium/simple buckets", () => {
    // Frontier-aware policy: hard agent work should keep the caller's
    // advanced model unless we have hard-bucket evidence. Falling back to a
    // medium bucket is how a cost optimizer becomes an unsafe cheap proxy.
    const p = policy();
    // Stash the bucket under chat:medium ONLY, leaving chat:hard
    // unrepresented in the policy.
    const chatMediumBucket = {
      ...p.buckets[0]!,
      task_type: "chat" as const,
      complexity: "medium" as const,
    };
    p.lookup["chat:medium"] = chatMediumBucket;

    const rec = recommendModel(p, "chat", "hard", "some-model-not-in-bucket", 0.05);
    expect(rec).toBeNull();
  });
});
