/**
 * Baseline routing policy types.
 *
 * The policy is a static artifact produced offline from a public
 * policy-eval mix across models TokSuan supports. It gives the gateway a
 * "cold-start" cost/quality map per task type, so even a brand-new hosted
 * customer gets cost savings on day one — before we've observed any of their
 * actual workload.
 *
 * Runtime contract:
 *   1. Gateway loads `baseline-policy.json` once at boot.
 *   2. Each request is classified into (task_type, complexity).
 *   3. Policy is consulted: "among models whose quality ≥ current_model - ε,
 *      which one has the lowest cost?" → downgrade suggestion.
 *   4. If no safe downgrade exists, we leave the model alone.
 *
 * The artifact is designed to be evolved from the in-system A/B shadow table
 * once real customer traffic exists — per-customer bandit overrides layer on
 * top of this baseline. That's Month 2+ work.
 */

export type TaskType = "code" | "reasoning" | "chat" | "tool_use";

export type ComplexityBucket = "simple" | "medium" | "hard" | "frontier";

export interface ModelStats {
  model: string;
  provider: string;
  /** Observed mean total cost per request in micro_cents. */
  avg_cost_micro_cents: number;
  /** Observed mean input / output token counts on this bucket. */
  avg_input_tokens: number;
  avg_output_tokens: number;
  /** Quality in [0, 1]. 0 = always wrong/useless, 1 = reference quality. */
  quality_score: number;
  /** Sample size (task count) behind these numbers. */
  n: number;
}

export interface PolicyBucket {
  task_type: TaskType;
  complexity: ComplexityBucket;
  /**
   * Pareto-frontier models for this bucket, sorted ascending by cost.
   * Only non-dominated models appear here — any model a strictly-better
   * alternative exists for is filtered out.
   */
  models: ModelStats[];
  /** Best quality achieved by any model in this bucket, used as baseline. */
  max_quality: number;
}

export interface BaselinePolicy {
  version: string;
  generated_at: string;
  benchmarks: string[];
  judge_model: string | null;
  /** Default epsilon — how much quality drop we'll accept for cost savings. */
  default_eps: number;
  buckets: PolicyBucket[];
  /** Fast-lookup map, key = `${task_type}:${complexity}`. Duplicate of `buckets`. */
  lookup: Record<string, PolicyBucket>;
}
