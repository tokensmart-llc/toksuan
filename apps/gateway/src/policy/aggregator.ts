/**
 * Per-project policy aggregator.
 *
 * Reads `ab_results` rows for a single project (over the last
 * `lookbackDays` window) plus the shipped baseline policy, then
 * produces a fresh `BaselinePolicy` JSON that the gateway will start
 * routing with after promotion.
 *
 * The math (intentionally simple)
 * --------------------------------
 * For each (task_type, complexity, model) cell we compute:
 *
 *   observed:   { n_obs,   cost_obs,   quality_obs   }   from ab_results
 *   prior:      { n_prior, cost_prior, quality_prior }   from baseline-policy
 *
 *   posterior_n     = n_obs + n_prior
 *   posterior_cost  = (cost_obs * n_obs + cost_prior * n_prior) / posterior_n
 *   posterior_qual  = (qual_obs * n_obs + qual_prior * n_prior) / posterior_n
 *
 * `n_prior` is configurable but defaults to PRIOR_STRENGTH (= 20). That
 * means a project with 100 real observations on a (bucket, model) cell
 * weighs its data 100/(100+20) ≈ 83% vs the baseline's 17%. A project
 * with only 5 real observations stays close to the baseline. This is
 * just a Bayesian conjugate update with a normal-normal prior — fancy
 * name for "weighted average that decays the prior as evidence grows".
 *
 * Why not full Bayesian inference (Beta-Bernoulli, hierarchical Stan,
 * etc.)? Because the dominant source of error in this pipeline is the
 * judge's quality_score being noisy, not our update rule. A weighted
 * average that an operator can read off a SQL query is the right
 * complexity for v1; the moment a customer complains "your aggregator
 * picked the wrong model on bucket X" we want them to be able to debug
 * it without a stats degree.
 *
 * What we score quality on
 * ------------------------
 * The shadow pipeline writes one of two signals into ab_results:
 *
 *   - `similarity` (cosine of embedded primary vs shadow response) —
 *     PRESENT for every successful shadow when an embedding model is
 *     configured. We treat this as a quality_score in [0, 1] (clamped
 *     from cosine [-1, 1] via max(0, x)).
 *   - `shadow_status` — coarse "did it 2xx" signal. Used as a tie-break:
 *     status='error' rows count as quality=0 regardless of similarity.
 *
 * If a project has zero similarity values yet (no embedding model set
 * up), the aggregator only updates COSTS (which are always observed)
 * and leaves quality_score == prior. This degrades gracefully — a
 * project that never enables a judge still gets cost-aware routing
 * tailored to its actual model latencies and token distributions.
 *
 * Pareto filtering
 * ----------------
 * After the per-cell update we re-Pareto-filter each bucket the same
 * way `extract-policy.ts` does for the baseline. The output shape is
 * IDENTICAL to baseline-policy.json — gateway code reading the policy
 * doesn't care whether it came from disk or pg.
 */

import { sql } from "../db";
import { loadBaselinePolicy } from "./index";
import type {
  BaselinePolicy,
  ComplexityBucket,
  ModelStats,
  PolicyBucket,
  TaskType,
} from "./types";
import { classifyTask } from "./task-classifier";
import type { OpenAIChatRequest } from "../providers/openai";

/**
 * Equivalent-sample-count of the prior. 20 means "treat the shipped
 * baseline as if it were 20 real observations of this cell". Project
 * data above this count starts dominating the posterior.
 */
const DEFAULT_PRIOR_STRENGTH = 20;

/** How many days of ab_results to read by default. */
const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Cells that landed in fewer than this many real observations after
 * the lookback window are NOT promoted past the prior — they keep the
 * baseline numbers. Avoids letting 1–2 noisy samples flip the model
 * choice for a bucket on a sparsely-trafficked project.
 */
const MIN_OBSERVATIONS_TO_UPDATE = 3;

export interface AggregatorOptions {
  /** How far back to look in ab_results. Default: 7 days. */
  lookbackDays?: number;
  /** Prior strength (effective sample count of the baseline). Default: 20. */
  priorStrength?: number;
  /**
   * Optional override for the baseline policy. Tests pass a synthetic
   * baseline; production leaves this undefined and uses the shipped
   * artifact via loadBaselinePolicy().
   */
  baseline?: BaselinePolicy | null;
  /**
   * If set, only consider ab_results from requests that carried this
   * exact `x-ts-tag` value. Lets one project run multiple workloads
   * (e.g. "chatbot" + "codegen") with their own independently-trained
   * policies. NULL/undefined = the project-default policy that mixes
   * every request.
   *
   * Per-tag policies are scored, stored, and looked up under
   * `(project_id, tag)`. The runtime loader (policy/loader.ts) prefers
   * a tag-specific match before falling back to the project default.
   */
  tag?: string | null;
}

export interface AggregateResult {
  /** The fresh policy ready to be inserted as a new project_policies row. */
  policy: BaselinePolicy;
  /** Total ab_results rows considered. Goes into `sample_count` column. */
  sample_count: number;
  /**
   * Per-bucket changelog lines suitable for the dashboard. One entry
   * per (task_type, complexity) bucket where the routing decision
   * actually CHANGED vs the baseline / previous policy.
   */
  bucket_changes: BucketChange[];
}

export interface BucketChange {
  task_type: TaskType;
  complexity: ComplexityBucket;
  /** Cheapest non-dominated model in the prior policy. */
  prior_winner: string | null;
  /** Cheapest non-dominated model in the new policy. */
  new_winner: string | null;
  /** Number of project observations that fed this bucket's update. */
  observed_n: number;
  /** Human-readable one-liner. */
  note: string;
}

/**
 * Read raw ab_results from the database for the requested window.
 * Exposed separately so tests can mock data without touching pg.
 *
 * When `tag` is set, the query JOINs to `requests` and filters for
 * rows where `requests.tags ?| ARRAY[tag]` (the request carried this
 * tag in `x-ts-tag`). When NULL, every shadow row for the project
 * counts toward the project-default policy.
 */
export async function loadAbResultsForProject(
  projectId: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
  tag: string | null = null
): Promise<AbResultRow[]> {
  // Cap lookback so a misconfigured CLI invocation can't lock the
  // table for an hour. 90 days is more than enough for any reasonable
  // training window.
  const days = Math.max(1, Math.min(lookbackDays, 90));
  if (tag) {
    return sql<AbResultRow[]>`
      SELECT
        ab.shadow_model,
        ab.shadow_provider,
        ab.shadow_input_tokens,
        ab.shadow_output_tokens,
        ab.shadow_cost_micro_cents,
        ab.shadow_status,
        ab.similarity,
        ab.primary_request_id
      FROM ab_results ab
      JOIN requests r ON r.id = ab.primary_request_id
      WHERE ab.project_id = ${projectId}
        AND ab.created_at > NOW() - (${days}::int || ' days')::interval
        AND r.tags ? ${tag}
    `;
  }
  return sql<AbResultRow[]>`
    SELECT
      shadow_model,
      shadow_provider,
      shadow_input_tokens,
      shadow_output_tokens,
      shadow_cost_micro_cents,
      shadow_status,
      similarity,
      primary_request_id
    FROM ab_results
    WHERE project_id = ${projectId}
      AND created_at > NOW() - (${days}::int || ' days')::interval
  `;
}

export type AbResultRow = {
  shadow_model: string;
  shadow_provider: string;
  shadow_input_tokens: number;
  shadow_output_tokens: number;
  shadow_cost_micro_cents: number;
  shadow_status: string;
  similarity: number | null;
  primary_request_id: string | null;
};

/**
 * Look up the original chat request body for each row so we can
 * classify (task_type, complexity). We do this in a separate pass
 * (a) to keep the ab_results query simple and (b) because most rows
 * share the same primary_request_id is unlikely but possible — a
 * request with two shadows would hit it.
 *
 * Done as one IN-list query; tens of thousands of ids fit comfortably.
 */
async function loadRequestBodies(
  requestIds: string[]
): Promise<Map<string, OpenAIChatRequest>> {
  const out = new Map<string, OpenAIChatRequest>();
  if (requestIds.length === 0) return out;
  const rows = await sql<{ id: string; request_body: unknown }[]>`
    SELECT id, request_body FROM requests WHERE id = ANY(${requestIds})
  `;
  for (const r of rows) {
    if (r.request_body && typeof r.request_body === "object") {
      out.set(r.id, r.request_body as OpenAIChatRequest);
    }
  }
  return out;
}

/**
 * Bucket the raw ab_results rows by (task_type, complexity, model).
 * Aggregates count, total cost (in micro_cents), and total
 * quality_score (sum, divided later for the mean).
 */
type CellAccumulator = {
  n: number;
  cost_sum_uc: number;
  input_tokens_sum: number;
  output_tokens_sum: number;
  quality_sum: number;
  quality_n: number; // separate count — not every row carries similarity
  provider: string;
};

function key(t: TaskType, c: ComplexityBucket, model: string): string {
  return `${t}::${c}::${model}`;
}

function emptyAccumulator(provider: string): CellAccumulator {
  return {
    n: 0,
    cost_sum_uc: 0,
    input_tokens_sum: 0,
    output_tokens_sum: 0,
    quality_sum: 0,
    quality_n: 0,
    provider,
  };
}

/**
 * Convert cosine-similarity in [-1, 1] to a quality score in [0, 1].
 * We deliberately clamp negatives to 0 instead of remapping (-1, 1) →
 * (0, 1) — a "negative similarity" almost always indicates the shadow
 * response went off-topic, which IS quality-zero from the user's
 * perspective.
 */
function similarityToQuality(sim: number | null): number | null {
  if (sim == null) return null;
  if (Number.isNaN(sim)) return null;
  return Math.max(0, Math.min(1, sim));
}

/**
 * Build per-cell accumulators from raw ab_results.
 */
function bucketize(
  rows: AbResultRow[],
  bodies: Map<string, OpenAIChatRequest>
): Map<string, CellAccumulator> {
  const cells = new Map<string, CellAccumulator>();
  for (const r of rows) {
    if (!r.primary_request_id) continue;
    const body = bodies.get(r.primary_request_id);
    if (!body) continue;
    const cls = classifyTask(body);
    const k = key(cls.task_type, cls.complexity, r.shadow_model);
    let cell = cells.get(k);
    if (!cell) {
      cell = emptyAccumulator(r.shadow_provider);
      cells.set(k, cell);
    }
    cell.n += 1;
    cell.cost_sum_uc += r.shadow_cost_micro_cents;
    cell.input_tokens_sum += r.shadow_input_tokens;
    cell.output_tokens_sum += r.shadow_output_tokens;
    // Quality: error → 0; success → similarity if present, else don't
    // contribute to the mean (leave quality_n unincremented).
    if (r.shadow_status === "error") {
      cell.quality_sum += 0;
      cell.quality_n += 1;
    } else {
      const q = similarityToQuality(r.similarity);
      if (q !== null) {
        cell.quality_sum += q;
        cell.quality_n += 1;
      }
    }
  }
  return cells;
}

/**
 * Bayesian-merge an observed cell with the prior cell from the baseline.
 *
 * `priorN` is the prior strength (effective sample count). The bigger
 * it is, the longer the baseline holds against new evidence.
 */
function mergeCell(
  obs: CellAccumulator | undefined,
  prior: ModelStats | undefined,
  model: string,
  priorN: number
): ModelStats | null {
  // No prior + no observation: this model isn't in the baseline AND
  // no project traffic touched it. Skip — there's nothing to learn from.
  if (!obs && !prior) return null;

  // Cold-shadow: a model the project has tried but isn't in the
  // baseline. Only emit it once it has minimum evidence; otherwise
  // a single noisy sample on an exotic model would pollute the bucket.
  if (!prior) {
    if (!obs || obs.n < MIN_OBSERVATIONS_TO_UPDATE) return null;
    return {
      model,
      provider: obs.provider,
      avg_cost_micro_cents: obs.cost_sum_uc / obs.n,
      avg_input_tokens: obs.input_tokens_sum / obs.n,
      avg_output_tokens: obs.output_tokens_sum / obs.n,
      quality_score:
        obs.quality_n > 0 ? obs.quality_sum / obs.quality_n : 0.5, // 0.5 = "we don't know yet"
      n: obs.n,
    };
  }

  // Prior-only or prior-dominant: not enough observation yet to
  // override the shipped baseline. Return the prior unchanged.
  if (!obs || obs.n < MIN_OBSERVATIONS_TO_UPDATE) {
    return prior;
  }

  // Posterior update.
  const totalN = obs.n + priorN;
  const obsAvgCost = obs.cost_sum_uc / obs.n;
  const obsAvgIn = obs.input_tokens_sum / obs.n;
  const obsAvgOut = obs.output_tokens_sum / obs.n;
  const obsQuality =
    obs.quality_n > 0 ? obs.quality_sum / obs.quality_n : prior.quality_score;

  return {
    model,
    provider: prior.provider,
    avg_cost_micro_cents:
      (obsAvgCost * obs.n + prior.avg_cost_micro_cents * priorN) / totalN,
    avg_input_tokens:
      (obsAvgIn * obs.n + prior.avg_input_tokens * priorN) / totalN,
    avg_output_tokens:
      (obsAvgOut * obs.n + prior.avg_output_tokens * priorN) / totalN,
    quality_score:
      (obsQuality * obs.n + prior.quality_score * priorN) / totalN,
    // We report the REAL observation count + the prior strength so the
    // dashboard's confidence indicator can reflect both.
    n: obs.n + priorN,
  };
}

/**
 * Pareto-filter a bucket: keep only models for which no other model
 * is strictly better on BOTH cost and quality. Mirrors the offline
 * extract-policy.ts logic so the runtime shape stays consistent.
 */
function paretoFrontier(models: ModelStats[]): ModelStats[] {
  return models.filter((m) =>
    !models.some(
      (other) =>
        other !== m &&
        other.avg_cost_micro_cents <= m.avg_cost_micro_cents &&
        other.quality_score >= m.quality_score &&
        (other.avg_cost_micro_cents < m.avg_cost_micro_cents ||
          other.quality_score > m.quality_score)
    )
  );
}

/**
 * Pick the lexicographically-deterministic "winner" for a bucket: the
 * cheapest model whose quality is within `default_eps` of the bucket's
 * top quality. This is what the dashboard changelog reports. (The
 * gateway's actual `recommendModel` runs the same logic per request
 * with the configured eps — we mirror it here just for the diff.)
 */
function bucketWinner(bucket: PolicyBucket, eps: number): string | null {
  if (bucket.models.length === 0) return null;
  const minQ = bucket.max_quality - eps;
  const eligible = bucket.models.filter((m) => m.quality_score >= minQ);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, m) =>
    m.avg_cost_micro_cents < best.avg_cost_micro_cents ? m : best
  ).model;
}

/**
 * Main entry point — produce a fresh `BaselinePolicy` for one project.
 */
export async function aggregateProjectPolicy(
  projectId: string,
  opts: AggregatorOptions = {}
): Promise<AggregateResult> {
  const lookback = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const priorN = opts.priorStrength ?? DEFAULT_PRIOR_STRENGTH;
  const tag = opts.tag ?? null;
  const baseline = opts.baseline ?? loadBaselinePolicy();

  if (!baseline) {
    throw new Error(
      "Cannot aggregate: no baseline policy available. Run the benchmark suite or ship a baseline-policy.json."
    );
  }

  const rows = await loadAbResultsForProject(projectId, lookback, tag);
  const bodies = await loadRequestBodies(
    rows.map((r) => r.primary_request_id).filter((id): id is string => !!id)
  );
  const cells = bucketize(rows, bodies);

  // Build the new buckets bucket-by-bucket. We start from the baseline's
  // bucket set (so untouched buckets carry through unchanged), then
  // merge in any models the project actually exercised.
  const newBuckets: PolicyBucket[] = [];
  const bucket_changes: BucketChange[] = [];

  for (const priorBucket of baseline.buckets) {
    // Collect every model name that appears either in the prior or in
    // observations for this bucket.
    const candidateModels = new Set<string>(
      priorBucket.models.map((m) => m.model)
    );
    for (const k of cells.keys()) {
      const [t, c, model] = k.split("::");
      if (
        t === priorBucket.task_type &&
        c === priorBucket.complexity &&
        model
      ) {
        candidateModels.add(model);
      }
    }

    const merged: ModelStats[] = [];
    let observedN = 0;
    for (const model of candidateModels) {
      const obs = cells.get(
        key(priorBucket.task_type, priorBucket.complexity, model)
      );
      const priorStats = priorBucket.models.find((m) => m.model === model);
      const stats = mergeCell(obs, priorStats, model, priorN);
      if (stats) merged.push(stats);
      if (obs) observedN += obs.n;
    }

    const filtered = paretoFrontier(merged).sort(
      (a, b) => a.avg_cost_micro_cents - b.avg_cost_micro_cents
    );
    const max_quality = filtered.length
      ? Math.max(...filtered.map((m) => m.quality_score))
      : priorBucket.max_quality;

    const newBucket: PolicyBucket = {
      task_type: priorBucket.task_type,
      complexity: priorBucket.complexity,
      models: filtered,
      max_quality,
    };
    newBuckets.push(newBucket);

    // Diff against the prior winner for the changelog. Use the
    // baseline's eps so the diff isn't sensitive to operator
    // env-var tweaks.
    const eps = baseline.default_eps;
    const priorWinner = bucketWinner(priorBucket, eps);
    const newWinner = bucketWinner(newBucket, eps);
    if (priorWinner !== newWinner && observedN > 0) {
      bucket_changes.push({
        task_type: priorBucket.task_type,
        complexity: priorBucket.complexity,
        prior_winner: priorWinner,
        new_winner: newWinner,
        observed_n: observedN,
        note: `${priorBucket.task_type}/${priorBucket.complexity}: ${priorWinner ?? "(none)"} → ${newWinner ?? "(none)"} after ${observedN} observation${observedN === 1 ? "" : "s"}`,
      });
    }
  }

  const lookup: Record<string, PolicyBucket> = {};
  for (const b of newBuckets) {
    lookup[`${b.task_type}:${b.complexity}`] = b;
  }

  // Version string: project version is bumped by the CLI when it
  // writes the row; the JSON payload's own `version` field carries
  // the baseline lineage so we can trace which prior fed which
  // posterior. Format: `<baseline_version>+proj.<unix_ms>`.
  const version = `${baseline.version}+proj.${Date.now()}`;

  return {
    policy: {
      version,
      generated_at: new Date().toISOString(),
      benchmarks: baseline.benchmarks,
      judge_model: baseline.judge_model,
      default_eps: baseline.default_eps,
      buckets: newBuckets,
      lookup,
    },
    sample_count: rows.length,
    bucket_changes,
  };
}
