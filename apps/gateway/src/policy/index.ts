import { readFileSync, existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { invalidateAllProjectPolicies } from "./loader";
import type {
  BaselinePolicy,
  ComplexityBucket,
  ModelStats,
  PolicyBucket,
  TaskType,
} from "./types";

export type { BaselinePolicy, ComplexityBucket, ModelStats, PolicyBucket, TaskType };
export {
  classifyTask,
  classifyTaskForProject,
  extractLastUserText,
  extractTextFromContent,
  extractUserIntent,
  type TaskClassification,
} from "./task-classifier";
export {
  loadActivePolicy,
  invalidateProjectPolicy,
  invalidateAllProjectPolicies,
  subscribeToPolicyInvalidations,
} from "./loader";
export {
  loadActiveEmbeddingClassifier,
  invalidateProjectEmbeddingClassifier,
  invalidateAllProjectEmbeddingClassifiers,
  subscribeToProjectEmbeddingInvalidations,
  _resetEmbeddingClassifierLoader,
} from "./embedding-classifier-loader";
export {
  ARTIFACT_SCHEMA_VERSION,
  describeStaleArtifactReason,
  loadEmbeddingClassifier,
  reloadEmbeddingClassifier,
  startEmbeddingClassifierFileWatcher,
  stopEmbeddingClassifierFileWatcher,
  subscribeToEmbeddingClassifierReload,
  classifyWithEmbedding,
  encodeText,
  encodeRequest,
  predictHead,
  type ArtifactSchemaVersion,
  type ClassifierArtifact,
  type ClassifierHead,
  type EncoderConfig,
  type EmbeddingPrediction,
  DEFAULT_ENCODER_CONFIG,
  LEGACY_V1_ENCODER_CONFIG,
  DEFAULT_NUM_BUCKETS,
  DEFAULT_NGRAM_SIZE,
} from "./embedding-classifier";

/**
 * Loaded-once policy artifact. We cache the first attempt (success or null)
 * so we don't hit the disk on every request and don't repeatedly log "no
 * artifact found" when the file simply doesn't exist.
 *
 * v0.6.5 — `cached` is no longer write-once. The file watcher +
 * pg_notify reload paths can replace the in-memory artifact at
 * runtime so an operator who refreshes the policy artifact doesn't have to
 * restart the gateway to pick up the new policy. `loadAttempted`
 * still gates the *first* load (so we don't disk-thrash on every
 * request when the file is absent), but `reloadBaselinePolicy()`
 * bypasses it.
 */
let cached: BaselinePolicy | null = null;
let loadAttempted = false;

function policyArtifactPath(): string {
  // v0.6.5 — `TOKENSMART_BASELINE_POLICY_PATH` lets operators stage a
  // candidate artifact for blue-green-style A/B testing without
  // touching the shipped one, AND lets unit tests redirect to a temp
  // file. Mirrors the existing `TOKENSMART_EMBEDDING_CLASSIFIER_PATH`
  // override pattern.
  const override = process.env.TOKENSMART_BASELINE_POLICY_PATH;
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "baseline-policy.json");
}

/**
 * Pure read-parse-validate. Returns the loaded artifact or null on any
 * failure (missing file / bad JSON / bad shape / placeholder). Logs are
 * `tag`-prefixed so operators can grep `[baseline-policy] reload` apart
 * from the boot-time `[baseline-policy] loaded` line.
 *
 * Does NOT mutate `cached` — callers (the boot loader vs the reload
 * path) decide what to do with the result. Keeps the two entry points
 * symmetric.
 */
function readBaselinePolicyFromDisk(
  p: string,
  tag: "load" | "reload"
): BaselinePolicy | null {
  if (!existsSync(p)) {
    if (tag === "reload") {
      console.log(
        `[baseline-policy] reload requested but ${p} missing — keeping current artifact`
      );
    }
    return null;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as BaselinePolicy;
    if (!parsed || !Array.isArray(parsed.buckets) || !parsed.lookup) {
      console.warn(
        `[baseline-policy] artifact at ${p} has unexpected shape — ignoring (${tag})`
      );
      return null;
    }
    if (parsed.buckets.length === 0) {
      // Placeholder / untrained artifact. Not an error, just nothing
      // to do. Logged on reload (so operator who deliberately
      // emptied the file knows we noticed) but stays quiet on the
      // boot-load path so a fresh install isn't noisy.
      if (tag === "reload") {
        console.log(
          `[baseline-policy] ${p} has zero buckets — treating as no-op (no rewrites until repopulated)`
        );
      }
      return null;
    }
    console.log(
      `[baseline-policy] ${tag}ed v=${parsed.version}, ${parsed.buckets.length} buckets, judge=${parsed.judge_model ?? "none"}`
    );
    return parsed;
  } catch (err) {
    console.warn(
      `[baseline-policy] failed to ${tag} ${p}: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Load the baseline-policy artifact bundled alongside this module.
 *
 * Returns `null` when the artifact is absent or malformed — in both cases
 * the gateway should continue to work, just without cold-start routing. A
 * self-hosted single-tenant install that never runs the benchmark suite
 * lives in this branch.
 */
export function loadBaselinePolicy(): BaselinePolicy | null {
  if (loadAttempted) return cached;
  loadAttempted = true;
  cached = readBaselinePolicyFromDisk(policyArtifactPath(), "load");
  return cached;
}

/**
 * Hot-reload entry point — drop the cached artifact and re-read from
 * disk. Called by the file-mtime watcher and the `pg_notify` subscriber
 * after the policy artifact is refreshed.
 *
 * Contract:
 *   - Safe to call from multiple signal paths (watch + notify can
 *     race; debounced upstream so reads don't pile up).
 *   - Last write wins. A read-during-write that lands on a half-
 *     flushed JSON file fails the JSON parse, gets logged, and the
 *     PRIOR cached artifact is preserved (we don't blow away a
 *     working policy because of one bad read).
 *   - **Also flushes the per-(project, tag) loader cache.** SQLite
 *     mode and postgres-mode-with-no-active-row both fall through
 *     to `loadBaselinePolicy()` from `loader.ts` and CACHE that
 *     result for 60s. Without the flush, those callers would still
 *     see the OLD baseline for up to a minute after reload — silent
 *     stale window. With the flush, the next request re-runs the
 *     fall-through and picks up the new artifact.
 *   - Returns the post-reload artifact (or null) so tests + a
 *     /health probe can assert reload state synchronously.
 */
export function reloadBaselinePolicy(): BaselinePolicy | null {
  const fresh = readBaselinePolicyFromDisk(policyArtifactPath(), "reload");
  // Atomic-ish swap: only overwrite `cached` on a successful read.
  // A failed read keeps the previous policy live, which is the right
  // failure mode for "operator hand-edited the file and broke the
  // JSON" — the gateway keeps routing on the last-known-good artifact
  // until the next successful read.
  if (fresh !== null) {
    cached = fresh;
    // Flush downstream cache. Cheap — the loader's cache scans its
    // own Map and clears entries; no DB or disk I/O.
    invalidateAllProjectPolicies();
  }
  loadAttempted = true;
  return cached;
}

// ===========================================================================
// Hot-reload plumbing — fs.watch() + pg_notify
// ===========================================================================
//
// Mirrors the v0.6.1 embedding-classifier reload pattern. Either signal
// path can trigger `reloadBaselinePolicy()` and both are independent +
// additive:
//
//   - **File watcher**: for single-node self-host installs where
//     the policy generator and gateway share a filesystem. Zero DB cost,
//     sub-second reload latency, dependency-free.
//   - **pg_notify (`tokensmart_baseline_reload` channel)**: for
//     multi-replica cloud installs where the bench job writes the
//     artifact on a separate pod. Operator can also fire it manually
//     via `psql -c "SELECT pg_notify('tokensmart_baseline_reload', '')"`.
//
// Both are OPT-IN via env (defaults ON when baseline policy is enabled).
// Failure to wire either one is non-fatal — degrades to "operator
// must restart the gateway to pick up a new artifact", which was
// pre-v0.6.5 behavior.

let fileWatcher: FSWatcher | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let notifySubscribed = false;

/**
 * Debounced reload — many filesystems (esp. macOS via node fs.watch)
 * emit multiple events per single write (chmod + rename + data). We
 * coalesce into one reload to keep logs sane + skip no-op re-reads.
 *
 * 300ms matches the embedding-classifier debounce so the two reload
 * paths log + finalize within the same beat under e.g. an automated
 * deploy that swaps both artifacts in one commit.
 */
function scheduleReload(source: "watch" | "notify"): void {
  if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
  reloadDebounceTimer = setTimeout(() => {
    reloadDebounceTimer = null;
    console.log(`[baseline-policy] reload triggered by ${source}`);
    reloadBaselinePolicy();
  }, 300);
  if (typeof (reloadDebounceTimer as NodeJS.Timeout).unref === "function") {
    (reloadDebounceTimer as NodeJS.Timeout).unref();
  }
}

/**
 * Start watching the artifact file for changes. Idempotent — multiple
 * calls during dev hot-reload are no-ops.
 *
 * Watches the FILE directly (not the directory) — Bun 1.3.x's
 * `fs.watch(dir, ...)` on macOS doesn't fire for in-directory writes
 * (verified with a probe; tracked upstream). File-watch works for the
 * common in-place artifact rewrite used by policy generators,
 * AND we explicitly re-establish the watcher on the `rename` event
 * the kernel emits when an editor / atomic-write replaces the inode
 * (without re-establishing, the next change event would be lost
 * because our subscription is bound to the old inode).
 *
 * Disabled by `TOKENSMART_BASELINE_POLICY_WATCH=0` (default ON when
 * baseline policy itself is enabled). Watcher errors are caught and
 * logged; a dead watcher degrades the install to "restart-only
 * reload" rather than crashing the gateway.
 */
export function startBaselinePolicyFileWatcher(): void {
  if (fileWatcher) return;
  if (process.env.TOKENSMART_BASELINE_POLICY_ENABLED === "0") return;
  if (process.env.TOKENSMART_BASELINE_POLICY_WATCH === "0") return;

  attachFileWatcher(policyArtifactPath(), "start");
}

/**
 * Internal — open an fs.watch handle on `p`. Used both by the initial
 * `startBaselinePolicyFileWatcher` boot path AND by the reattach
 * path that fires after a `rename` event invalidates the prior
 * subscription. Logging differentiates "start" from "reattach" so
 * operators reading the log can tell the steady-state subscribe from
 * a swap-driven re-subscribe.
 */
function attachFileWatcher(p: string, source: "start" | "reattach"): void {
  // If we got here via the rename path, the prior watcher object is
  // already detached from the (now-deleted) inode but still listed in
  // `fileWatcher`. Close it to release the underlying handle before
  // opening a fresh one on the new inode.
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch {
      /* ignore */
    }
    fileWatcher = null;
  }
  if (!existsSync(p)) {
    // Race: the artifact got deleted before we could re-attach.
    // Best-effort retry once after the debounce window — in practice
    // a rename-in-place flow is delete-then-create, and the create
    // races with our re-attach. Schedule a reload anyway so the next
    // existsSync check (inside readBaselinePolicyFromDisk) handles
    // the absent-file case loudly.
    if (source === "reattach") {
      scheduleReload("watch");
    }
    return;
  }
  try {
    fileWatcher = fsWatch(p, (evt, filename) => {
      scheduleReload("watch");
      if (evt === "rename") {
        // The current subscription is stale. Re-attach asynchronously
        // (after our debounce fires). We do it on the next event loop
        // tick so the close() doesn't race the in-flight callback.
        setImmediate(() => attachFileWatcher(p, "reattach"));
      }
      void filename;
    });
    fileWatcher.on("error", (err) => {
      console.warn(
        `[baseline-policy] file watcher error: ${err.message} — falling back to restart-only reload`
      );
      try {
        fileWatcher?.close();
      } catch {
        /* ignore */
      }
      fileWatcher = null;
    });
    if (source === "start") {
      console.log(
        `[baseline-policy] watching ${p} for artifact updates (disable with TOKENSMART_BASELINE_POLICY_WATCH=0)`
      );
    }
  } catch (err) {
    console.warn(
      `[baseline-policy] could not ${source} file watcher on ${p}: ${(err as Error).message} — falling back to restart-only reload`
    );
    fileWatcher = null;
  }
}

/**
 * Stop the file watcher. Mostly for tests + clean shutdown paths.
 * Safe to call even when no watcher was ever started.
 */
export function stopBaselinePolicyFileWatcher(): void {
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch {
      /* ignore */
    }
    fileWatcher = null;
  }
}

/**
 * Subscribe to `tokensmart_baseline_reload` Postgres notifications.
 * Emitted by policy generators after a successful artifact write (when
 * it has DB access) OR by an operator via
 * `SELECT pg_notify('tokensmart_baseline_reload', '')`. Any payload
 * is fine — we always re-read the whole artifact.
 *
 * Mirrors `subscribeToPolicyInvalidations` in `loader.ts` so multi-
 * replica fan-out behaves the same across these two reload channels.
 *
 * The `sql` arg is injected by the caller (normally `index.ts`) to
 * mirror the embedding-classifier's pattern + let tests inject a mock.
 */
export async function subscribeToBaselinePolicyReload(sqlClient: {
  listen: (
    channel: string,
    cb: (payload: string | null) => void
  ) => Promise<unknown>;
}): Promise<void> {
  if (notifySubscribed) return;
  if (process.env.TOKENSMART_BASELINE_POLICY_ENABLED === "0") return;
  notifySubscribed = true;

  try {
    await sqlClient.listen("tokensmart_baseline_reload", () => {
      scheduleReload("notify");
    });
    console.log(
      "[baseline-policy] subscribed to tokensmart_baseline_reload (cross-replica hot-reload)"
    );
  } catch (err) {
    notifySubscribed = false;
    console.warn(
      `[baseline-policy] LISTEN setup failed: ${(err as Error).message} — falling back to file-watch only`
    );
  }
}

/**
 * Test-only reset hook so unit tests don't bleed loader state across
 * cases. Resets BOTH the cached artifact AND the pg_notify
 * subscription bookkeeping so a test that simulates subscribe-failure
 * doesn't get short-circuited by a previous test's success.
 */
export function _resetBaselinePolicy(): void {
  cached = null;
  loadAttempted = false;
  notifySubscribed = false;
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = null;
  }
  stopBaselinePolicyFileWatcher();
}

export interface PolicyRecommendation {
  recommended: string;
  task_type: TaskType;
  complexity: ComplexityBucket;
  expected_quality: number;
  expected_cost_micro_cents: number;
  /** Machine-readable reason, safe to log. */
  reason: string;
}

/**
 * Per-task-type quality-drop tolerance multipliers. Different tasks have
 * radically different sensitivity to quality regressions:
 *
 *   chat     — A joke / acknowledgement / casual reply is essentially
 *              fungible across frontier-class models. Users can't perceive
 *              a 5–10% LLM-judge score difference. Default 2× the user-set
 *              eps to capture more savings.
 *   code     — Code either passes tests or it doesn't. A 5pp quality drop
 *              IS a measurable real failure rate. Use eps as-is.
 *   reasoning— Wrong reasoning misleads the user invisibly (no test).
 *              Use eps as-is — strict.
 *   tool_use — A wrong tool call breaks an agent loop. Strict, eps as-is.
 *
 * Multipliers are applied to the env-configured eps so the user retains
 * control: TOKENSMART_BASELINE_POLICY_EPS=0.05 → chat sees 0.10, others
 * see 0.05. Setting EPS=0 still disables routing for all tasks.
 */
const EPS_MULTIPLIER: Record<TaskType, number> = {
  chat: 2.0,
  code: 1.0,
  reasoning: 1.0,
  tool_use: 1.0,
};

function effectiveEps(task_type: TaskType, configuredEps: number): number {
  return configuredEps * EPS_MULTIPLIER[task_type];
}

/**
 * Minimum sample count required for `recommendModel` to fire a route in
 * `hard` / `frontier` complexity buckets — the highest-risk tiers where
 * silent quality regression hurts most. Defaults to 3 to match the same
 * "stats are trustworthy" floor the aggregator (`extract-policy.ts`)
 * applies via `arr.length < 3` BEFORE writing the policy: any model that
 * survives into a bucket already cleared that bar, so re-checking with a
 * stricter threshold here just gates real demos off needlessly. Operators
 * running at scale with rich bench data can ratchet the floors up via
 * env (`TOKENSMART_BASELINE_HARD_MIN_N` / `..._FRONTIER_MIN_N`) without
 * touching code.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const HARD_COMPLEXITY_MIN_N_FOR_ROUTE = envInt(
  "TOKENSMART_BASELINE_HARD_MIN_N",
  3
);
const FRONTIER_COMPLEXITY_MIN_N_FOR_ROUTE = envInt(
  "TOKENSMART_BASELINE_FRONTIER_MIN_N",
  3
);

/**
 * Bucket fallback ladder. When the exact (task_type, complexity) bucket
 * doesn't exist in the policy artifact (e.g. the public policy-eval
 * mix never produced any "simple" rows because the bucketing
 * heuristic only emitted medium/hard), we fall back to a wider bucket
 * that's still meaningful:
 *
 *   simple → medium → hard   (simple tasks are at LEAST as routable as
 *                             medium, and we keep walking when neither
 *                             exists for this task type)
 *   medium → hard → simple   (medium falls back to hard's frontier, then
 *                             to simple if even hard isn't trained)
 *   hard   → hard only        (hard/agentic work should not silently fall
 *                             back to a cheaper medium/simple frontier. If
 *                             we have no hard evidence, keep the caller's
 *                             advanced model.)
 *   frontier → frontier only  (highest-risk tasks require direct evidence;
 *                             no downgrade is better than a fake saving)
 *
 * This keeps easy/medium runtime routing alive when training data has gaps
 * while preserving the product promise for hard agent work: optimize only
 * when we have hard-bucket evidence.
 */
const COMPLEXITY_FALLBACK: Record<ComplexityBucket, ComplexityBucket[]> = {
  simple: ["simple", "medium", "hard", "frontier"],
  medium: ["medium", "hard", "simple"],
  hard: ["hard"],
  frontier: ["frontier"],
};

const TASK_TYPE_FALLBACK: Record<TaskType, TaskType[]> = {
  chat: ["chat"],
  code: ["code"],
  reasoning: ["reasoning"],
  // Public cold-start benchmarks do not always produce a native tool_use
  // bucket, while agent traffic depends heavily on tools. Fall back to the
  // stricter reasoning buckets rather than treating tool calls as chat.
  tool_use: ["tool_use", "reasoning"],
};

function findBucketWithFallback(
  policy: BaselinePolicy,
  task_type: TaskType,
  complexity: ComplexityBucket
): {
  bucket: PolicyBucket;
  resolved_task_type: TaskType;
  resolved_complexity: ComplexityBucket;
} | null {
  for (const t of TASK_TYPE_FALLBACK[task_type]) {
    for (const c of COMPLEXITY_FALLBACK[complexity]) {
      const b = policy.lookup[`${t}:${c}`];
      if (b && b.models.length > 0) {
        return { bucket: b, resolved_task_type: t, resolved_complexity: c };
      }
    }
  }
  return null;
}

/**
 * Given a loaded policy + the current request's classification, suggest the
 * cheapest model whose expected quality is within `eps` of the `currentModel`
 * (or within `eps` of the best-in-bucket if the current model isn't in the
 * policy).
 *
 * Returns `null` when:
 *   - No bucket exists for this (task_type, complexity) even after fallback
 *   - No eligible downgrade is cheaper than `currentModel`
 *   - `currentModel` is already at or below the Pareto frontier's bottom
 */
export function recommendModel(
  policy: BaselinePolicy,
  task_type: TaskType,
  complexity: ComplexityBucket,
  currentModel: string,
  eps: number,
  opts: { excludedModels?: ReadonlySet<string> } = {}
): PolicyRecommendation | null {
  const found = findBucketWithFallback(policy, task_type, complexity);
  if (!found) return null;
  const { bucket, resolved_task_type, resolved_complexity } = found;
  const fellBack =
    resolved_task_type !== task_type || resolved_complexity !== complexity;

  // Per-task tolerance — chat tolerates more quality drop than code/reasoning.
  const tunedEps = effectiveEps(task_type, eps);

  // What quality are we comparing against?
  //   - If the caller's model is in the bucket, use its quality as the anchor.
  //   - Otherwise use the bucket's max_quality so we don't accidentally recommend
  //     something worse than an unmeasured-but-probably-good model.
  const currentStats: ModelStats | undefined = bucket.models.find(
    (m) => m.model === currentModel
  );
  if ((complexity === "hard" || complexity === "frontier") && !currentStats) {
    return null;
  }
  const anchorQuality = currentStats
    ? currentStats.quality_score
    : bucket.max_quality;

  const minAcceptableQuality = anchorQuality - tunedEps;

  // Find cheapest model at or above the quality floor.
  let winner: ModelStats | null = null;
  for (const m of bucket.models) {
    if (opts.excludedModels?.has(m.model)) continue;
    if (m.quality_score < minAcceptableQuality) continue;
    if (!winner || m.avg_cost_micro_cents < winner.avg_cost_micro_cents) {
      winner = m;
    }
  }

  if (!winner) return null;
  if (complexity === "hard" && winner.n < HARD_COMPLEXITY_MIN_N_FOR_ROUTE) {
    return null;
  }
  if (
    complexity === "frontier" &&
    winner.n < FRONTIER_COMPLEXITY_MIN_N_FOR_ROUTE
  ) {
    return null;
  }
  if (winner.model === currentModel) return null;

  // Only recommend a downgrade if it's actually cheaper than the anchor.
  if (currentStats && winner.avg_cost_micro_cents >= currentStats.avg_cost_micro_cents) {
    return null;
  }

  return {
    recommended: winner.model,
    task_type,
    complexity,
    expected_quality: winner.quality_score,
    expected_cost_micro_cents: winner.avg_cost_micro_cents,
    reason: `baseline:${task_type}:${complexity}${fellBack ? `→${resolved_task_type}:${resolved_complexity}` : ""}:q=${winner.quality_score.toFixed(2)}:n=${winner.n}:eps=${tunedEps.toFixed(2)}`,
  };
}
