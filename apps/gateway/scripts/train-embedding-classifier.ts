#!/usr/bin/env bun
/**
 * Train the embedding-based task classifier from real `requests` traffic.
 *
 * Pipeline
 * --------
 *   1. Pull every successful request_body from the last N days (default
 *      30) for one project, OR for all projects merged into a single
 *      global classifier (the default — same artifact serves every
 *      tenant unless they opt into per-project models).
 *   2. Derive WEAK LABELS for each row:
 *        - `task_type`  — straight from the heuristic. The heuristic is
 *          high-precision on the ~70% of traffic that hits one of its
 *          regex patterns; for the remaining 30% it defaults to "chat",
 *          which is also the dominant class so it doesn't hurt.
 *        - `complexity` — heuristic baseline, REFINED by joining to
 *          `ab_results.similarity`:
 *             * if cheaper-shadow similarity ≥ 0.95 across all shadows
 *               for this prompt's fingerprint → label as `simple`
 *               (a cheap model already produced indistinguishable
 *               output, so the prompt is by definition not "hard").
 *             * if cheaper-shadow similarity < 0.7 OR shadow_status =
 *               'error' → label as `hard` (cheap models can't keep up).
 *             * otherwise → keep heuristic label.
 *   3. Filter low-confidence rows out of TRAINING (but keep them in
 *      VALIDATION for honest accuracy reporting):
 *        - skip rows with no extractable user text
 *        - skip rows where the heuristic landed exactly on the
 *          ambiguous-region thresholds (score ∈ [0.22, 0.28] or
 *          [0.57, 0.63]) AND we have no shadow refinement to
 *          arbitrate
 *   4. 80/20 train/validation split — chronological so the validation
 *      set represents the most recent traffic shape (tomorrow's
 *      classifier is judged on today's traffic distribution, not
 *      last month's).
 *   5. Mini-batch SGD with cross-entropy loss, two heads (task_type
 *      and complexity). L2 regularization + simple learning-rate decay.
 *      No external ML library — the math fits in <100 LOC and we don't
 *      want a 200MB pytorch dep on the gateway image.
 *   6. Threshold calibration: pick the per-head softmax confidence
 *      threshold that keeps "wrong predictions trusted" below 5% on
 *      the validation set. Below the threshold, the runtime falls
 *      back to the heuristic.
 *   7. Write `apps/gateway/src/policy/embedding-classifier.json`. The
 *      gateway picks it up on next boot (or via a planned
 *      reload-without-restart hook).
 *
 * Cron usage
 * ----------
 *   # Weekly retrain across all paid projects, default lookback 30d.
 *   bun run train-embedding-classifier
 *
 *   # Per-project run (out: --output is a custom path the gateway
 *   # can be pointed at via TOKENSMART_EMBEDDING_CLASSIFIER_PATH).
 *   bun run train-embedding-classifier -- \
 *       --project <uuid> \
 *       --output ./tenant-<uuid>-classifier.json
 *
 *   # Dry-run to inspect what WOULD be trained, without writing.
 *   bun run train-embedding-classifier -- --lookback-days 7 --dry-run
 *
 * What this is and isn't
 * ----------------------
 * This is fastText-style hash-trick + linear softmax. NOT mini-BERT.
 * The user's spec mentioned "fastText / mini-BERT" — fastText is the
 * right pick because:
 *
 *   - mini-BERT-class transformer adds ~5–20ms inference latency on
 *     CPU even with ONNX runtime, plus a 100MB+ runtime dep we don't
 *     want shipped in a gateway container.
 *   - The marginal accuracy mini-BERT buys (~3-5pp on the kind of
 *     short routing classifications we do here) is wiped out by
 *     gating + heuristic fallback anyway.
 *   - Hash-trick + linear is dependency-free, deterministic, and
 *     trains in seconds on commodity hardware — operators can
 *     re-run it in a CI cron job without provisioning GPUs.
 *
 * If a customer eventually demands the last 3pp we can switch the
 * encoder for a sentence-transformers ONNX export and keep the rest
 * of the pipeline unchanged. The artifact format already accommodates
 * this — just bump `schema_version`.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sql, dbBackend } from "../src/db";
import { classifyTask } from "../src/policy/task-classifier";
import { complexityScore } from "../src/classifier";
import { dispatchAlert } from "../src/alerts";
import {
  ARTIFACT_SCHEMA_VERSION,
  encodeRequest,
  DEFAULT_ENCODER_CONFIG,
  LEGACY_V1_ENCODER_CONFIG,
  type EncoderConfig,
  type ClassifierArtifact,
  type ClassifierHead,
} from "../src/policy/embedding-classifier";
import type { OpenAIChatRequest } from "../src/providers/openai";
import type { TaskType, ComplexityBucket } from "../src/policy/types";

const TASK_TYPES: TaskType[] = ["chat", "code", "reasoning", "tool_use"];
const COMPLEXITY: ComplexityBucket[] = ["simple", "medium", "hard"];

// =========================================================================
// CLI arg parsing
// =========================================================================

interface Args {
  project: string | null;
  /** Batch mode: iterate every `projects.learning_enabled=TRUE` row,
   *  train one artifact per project. Mirrors `retrain-project
   *  --all-enabled`. Per-project errors don't kill the batch. */
  allEnabled: boolean;
  lookbackDays: number;
  output: string;
  dryRun: boolean;
  /** Storage target. Default `auto` picks `db` when a projectId is
   *  provided (either `--project` or `--all-enabled`), else `disk`
   *  (global artifact at `src/policy/embedding-classifier.json`).
   *  Explicit `db` / `disk` overrides. */
  store: "auto" | "db" | "disk";
  /** Source label stamped on the inserted DB row. 'manual' for explicit
   *  `--project` runs, 'nightly_retrain' for `--all-enabled`. */
  source: "manual" | "nightly_retrain" | "backfill";
  /** Free-text notes for the DB row's `notes` column. */
  notes: string | null;
  /** Escape hatch for deliberate self-distillation experiments. */
  iKnowWhatImDoing: boolean;
  /** Mini-batch SGD knobs. Defaults are conservative. */
  epochs: number;
  batchSize: number;
  learningRate: number;
  l2: number;
  /** Random seed for the train/test split — deterministic re-runs in CI. */
  seed: number;
  /** Min training rows before we'll write an artifact at all. Below this
   *  the classifier is too noisy to trust; we emit a warning instead. */
  minRows: number;
  /** Quality floor for the two heads. Below this, the row is written
   *  as `status='rejected'` (kept for forensics) and NOT promoted to
   *  active. Default 0.6 — lenient enough that a warming-up tenant's
   *  first successful artifact still lands, strict enough that a
   *  noisy retrain doesn't regress routing. Setting to 0 disables the
   *  floor. Applied ONLY in db-store mode (disk-store keeps existing
   *  unconditional behavior for single-tenant self-host). */
  minTaskTypeAccuracy: number;
  minComplexityAccuracy: number;
  /** Encoder overrides. Default undefined → use DEFAULT_ENCODER_CONFIG
   *  (multilingual v2). Operators who want a tighter / wider bucket
   *  space OR want to disable v2 features override per-run. All values
   *  land in the artifact's encoder config so inference matches train. */
  numBuckets?: number;
  ngramSize?: number;
  maxChars?: number;
  legacyV1Encoder: boolean;
  /** Pretty-print the artifact JSON for human inspection. Default off
   *  because the artifact is consumed by the gateway, not read by humans
   *  outside debugging sessions. */
  pretty: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    project: null,
    allEnabled: false,
    lookbackDays: 30,
    output: defaultOutputPath(),
    dryRun: false,
    store: "auto",
    source: "manual",
    notes: null,
    iKnowWhatImDoing: false,
    epochs: 8,
    batchSize: 64,
    learningRate: 0.5,
    l2: 1e-4,
    seed: 42,
    minRows: 50,
    minTaskTypeAccuracy: 0.6,
    minComplexityAccuracy: 0.6,
    legacyV1Encoder: false,
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--project":
        a.project = next ?? null;
        i++;
        break;
      case "--all-enabled":
        a.allEnabled = true;
        a.source = "nightly_retrain";
        break;
      case "--lookback-days":
        a.lookbackDays = posInt(next, "--lookback-days");
        i++;
        break;
      case "--output":
        a.output = path.resolve(next ?? "");
        i++;
        break;
      case "--store":
        if (next !== "auto" && next !== "db" && next !== "disk") {
          fail(`--store must be one of auto|db|disk (got ${next})`);
        }
        a.store = next;
        i++;
        break;
      case "--source":
        if (
          next !== "manual" &&
          next !== "nightly_retrain" &&
          next !== "backfill"
        ) {
          fail(
            `--source must be one of manual|nightly_retrain|backfill (got ${next})`
          );
        }
        a.source = next;
        i++;
        break;
      case "--notes":
        a.notes = next ?? null;
        i++;
        break;
      case "--epochs":
        a.epochs = posInt(next, "--epochs");
        i++;
        break;
      case "--batch-size":
        a.batchSize = posInt(next, "--batch-size");
        i++;
        break;
      case "--learning-rate":
        a.learningRate = posFloat(next, "--learning-rate");
        i++;
        break;
      case "--l2":
        a.l2 = nonNegFloat(next, "--l2");
        i++;
        break;
      case "--seed":
        a.seed = posInt(next, "--seed");
        i++;
        break;
      case "--min-rows":
        a.minRows = posInt(next, "--min-rows");
        i++;
        break;
      case "--min-task-type-accuracy":
        a.minTaskTypeAccuracy = nonNegFloat(next, "--min-task-type-accuracy");
        i++;
        break;
      case "--min-complexity-accuracy":
        a.minComplexityAccuracy = nonNegFloat(next, "--min-complexity-accuracy");
        i++;
        break;
      case "--num-buckets":
        a.numBuckets = posInt(next, "--num-buckets");
        i++;
        break;
      case "--ngram-size":
        a.ngramSize = posInt(next, "--ngram-size");
        i++;
        break;
      case "--max-chars":
        a.maxChars = posInt(next, "--max-chars");
        i++;
        break;
      case "--legacy-v1-encoder":
        a.legacyV1Encoder = true;
        break;
      case "--pretty":
        a.pretty = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--i-know-what-im-doing":
        a.iKnowWhatImDoing = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg && arg.startsWith("--")) fail(`unknown flag: ${arg}`);
    }
  }
  // Basic sanity on encoder overrides. num_buckets must be > ngram_size + 2
  // (the padded boundary needs room), and max_chars must be at least a
  // few chars so we can still hash something.
  if (a.numBuckets != null && a.numBuckets < 64) {
    fail(`--num-buckets must be >= 64 (got ${a.numBuckets})`);
  }
  if (a.ngramSize != null && (a.ngramSize < 2 || a.ngramSize > 6)) {
    fail(`--ngram-size must be in [2, 6] (got ${a.ngramSize})`);
  }
  if (a.maxChars != null && a.maxChars < 10) {
    fail(`--max-chars must be >= 10 (got ${a.maxChars})`);
  }
  if (a.minTaskTypeAccuracy > 1 || a.minComplexityAccuracy > 1) {
    fail(`--min-*-accuracy must be in [0, 1]`);
  }
  if (a.allEnabled && a.project) {
    fail(`--project and --all-enabled are mutually exclusive`);
  }
  return a;
}

function posInt(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    fail(`${name} must be a positive integer (got ${v})`);
  }
  return n;
}
function posFloat(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`${name} must be a positive number (got ${v})`);
  }
  return n;
}
function nonNegFloat(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    fail(`${name} must be a non-negative number (got ${v})`);
  }
  return n;
}

function defaultOutputPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    here,
    "..",
    "src",
    "policy",
    "embedding-classifier.json"
  );
}

function fail(msg: string): never {
  console.error(`train-embedding-classifier: ${msg}\n`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`Usage:
  bun run train-embedding-classifier [-- options]

Pulls real \`requests\` traffic, derives weak labels via the heuristic
classifier (refined by ab_results.similarity for complexity), trains a
fastText-style hashed-trigram + linear softmax classifier, and writes
the JSON artifact the gateway loads at boot.

Options:
  -- Project targeting ---
  --project <uuid>     Train scoped to one project. Writes to
                       project_embedding_classifiers (unless --store=disk).
  --all-enabled        Iterate every projects.learning_enabled=TRUE row and
                       train one artifact per project. Cloud nightly-cron
                       mode. Per-project errors are logged + alert-dispatched
                       but don't kill the batch.
  --lookback-days N    Days of requests to read. Default: 30. Cap: 90.

  -- Storage ---
  --store auto|db|disk Where the artifact lands. 'auto' (default) picks 'db'
                       when --project or --all-enabled is set, else 'disk'.
                       'db' writes to project_embedding_classifiers (per
                       project). 'disk' writes to --output (global artifact).
  --output PATH        Disk-store path. Default: src/policy/embedding-classifier.json.
                       Ignored when --store=db.
  --source LABEL       Stamp on the DB row (manual|nightly_retrain|backfill).
                       Default: 'nightly_retrain' with --all-enabled, else
                       'manual'.
  --notes TEXT         Free-text rationale stored on the DB row.
  --dry-run            Train + report metrics, don't write anything.

  -- Quality gate (--store=db only) ---
  --min-task-type-accuracy F     Minimum validation accuracy for task_type
                                  head. Below this, the row lands as
                                  'rejected' and the prior 'active' stays in
                                  place. Default: 0.6.
  --min-complexity-accuracy F    Same for complexity head. Default: 0.6.

  -- Safety ---
  --i-know-what-im-doing
                       Allow training while TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED=1.
                       Normally refused to avoid self-distillation from live predictions.

  -- Mini-batch SGD ---
  --epochs N           Mini-batch SGD epochs. Default: 8.
  --batch-size N       Default: 64.
  --learning-rate N    Default: 0.5.
  --l2 N               L2 regularization strength. Default: 1e-4.
  --seed N             Random seed for split + shuffle. Default: 42.
  --min-rows N         Min training rows required to emit. Default: 50.

  -- Encoder overrides (all persist into artifact.encoder) ---
  --num-buckets N      Feature space dimensionality. Default: 4096. Must be
                       >= 64. Bump to 8192 / 16384 for tenants with high
                       vocabulary diversity and visible collision hotspots.
  --ngram-size N       Character n-gram size in [2, 6]. Default: 3.
  --max-chars N        Truncate input beyond this length BEFORE trigramming.
                       Default: 4000.
  --legacy-v1-encoder  Disable the v2 multilingual preprocessing (NFKC, zero-
                       width strip, whitespace collapse, CJK bigrams).
                       Reproduces pre-v0.6.1 encoder exactly — use only when
                       comparing a new artifact against a v1 baseline.

  -- Output formatting ---
  --pretty             Pretty-print the artifact JSON (2-space indent).
                       Roughly 2× the file size; useful for \`diff\`-ing two
                       trained artifacts in code review.

Examples:
  # Manual per-project training (writes to DB, auto-promotes)
  bun run train-embedding-classifier -- --project 00000000-0000-0000-0000-000000000001

  # Cloud nightly cron — walk all paid projects
  bun run train-embedding-classifier -- --all-enabled

  # Self-host global artifact (pre-v0.7 behavior)
  bun run train-embedding-classifier -- --lookback-days 30

  # Dry-run to preview what WOULD happen
  bun run train-embedding-classifier -- --all-enabled --dry-run
`);
}

// =========================================================================
// Data loading
// =========================================================================

interface RawRow {
  id: string;
  request_body: unknown;
  fingerprint: string | null;
}

interface ShadowRow {
  primary_request_id: string;
  similarity: number | null;
  shadow_status: string;
  shadow_cost_micro_cents: number;
  primary_cost_micro_cents: number;
}

async function loadRequests(project: string | null, days: number): Promise<RawRow[]> {
  const cappedDays = Math.max(1, Math.min(days, 90));
  if (project) {
    return sql<RawRow[]>`
      SELECT id, request_body, fingerprint
      FROM requests
      WHERE project_id = ${project}
        AND status = 'success'
        AND created_at > NOW() - (${cappedDays}::int || ' days')::interval
        AND request_body IS NOT NULL
      ORDER BY created_at ASC
    `;
  }
  return sql<RawRow[]>`
    SELECT id, request_body, fingerprint
    FROM requests
    WHERE status = 'success'
      AND created_at > NOW() - (${cappedDays}::int || ' days')::interval
      AND request_body IS NOT NULL
    ORDER BY created_at ASC
  `;
}

async function loadShadows(
  project: string | null,
  days: number
): Promise<Map<string, ShadowRow[]>> {
  const cappedDays = Math.max(1, Math.min(days, 90));
  const rows = project
    ? await sql<ShadowRow[]>`
        SELECT primary_request_id, similarity, shadow_status,
               shadow_cost_micro_cents, primary_cost_micro_cents
        FROM ab_results
        WHERE project_id = ${project}
          AND created_at > NOW() - (${cappedDays}::int || ' days')::interval
          AND primary_request_id IS NOT NULL
      `
    : await sql<ShadowRow[]>`
        SELECT primary_request_id, similarity, shadow_status,
               shadow_cost_micro_cents, primary_cost_micro_cents
        FROM ab_results
        WHERE created_at > NOW() - (${cappedDays}::int || ' days')::interval
          AND primary_request_id IS NOT NULL
      `;
  const out = new Map<string, ShadowRow[]>();
  for (const r of rows) {
    const arr = out.get(r.primary_request_id);
    if (arr) arr.push(r);
    else out.set(r.primary_request_id, [r]);
  }
  return out;
}

// =========================================================================
// Weak labeling
// =========================================================================

interface LabeledExample {
  /** Encoded once, kept on the heap for all SGD passes. */
  features: Float32Array;
  task_type_idx: number;
  complexity_idx: number;
  /** Whether shadow data refined complexity (vs heuristic alone). */
  complexity_refined: boolean;
  /** The heuristic's [0,1] complexity score for this row. Stored so the
   *  ambiguity filter (`isTrainable`) doesn't need to redo the heuristic
   *  pass against the original `request_body`. */
  heuristic_score: number;
}

function deriveLabels(
  body: OpenAIChatRequest,
  shadows: ShadowRow[] | undefined
): {
  task_type: TaskType;
  complexity: ComplexityBucket;
  refined: boolean;
} | null {
  const heuristic = classifyTask(body);
  // The heuristic itself is now smart enough to consult the embedding
  // classifier when one is loaded — for training we explicitly want the
  // RAW heuristic label (otherwise the model is being trained against
  // its own predictions and degenerates). We re-derive task_type by
  // calling the regex-only pieces, NOT classifyTask.
  // BUT classifyTask falls back to the heuristic when no embedding
  // classifier is loaded. For SAFETY we ALSO require the embedding
  // classifier env-flag is OFF during training — see preflight() below.
  const task_type: TaskType = heuristic.task_type;

  // Complexity refinement from shadow A/B.
  let complexity: ComplexityBucket = heuristic.complexity;
  let refined = false;
  if (shadows && shadows.length > 0) {
    // Only consider shadows where the SHADOW model was CHEAPER than the
    // primary — those are real "can a cheaper model keep up?" signals.
    const cheaper = shadows.filter(
      (s) => s.shadow_cost_micro_cents < s.primary_cost_micro_cents
    );
    if (cheaper.length > 0) {
      // If any cheap shadow erred or scored low → label hard.
      const anyBad = cheaper.some(
        (s) =>
          s.shadow_status === "error" ||
          (s.similarity != null && s.similarity < 0.7)
      );
      if (anyBad) {
        complexity = "hard";
        refined = true;
      } else {
        // All cheap shadows tracked the primary closely → simple.
        const allGood = cheaper.every(
          (s) =>
            s.shadow_status !== "error" &&
            s.similarity != null &&
            s.similarity >= 0.95
        );
        if (allGood) {
          complexity = "simple";
          refined = true;
        }
      }
    }
  }

  return { task_type, complexity, refined };
}

/**
 * Decide whether a row should enter TRAINING (vs only validation).
 * Drops rows where the heuristic difficulty score sits exactly on a
 * bucket boundary AND we have no shadow refinement — these are rows
 * the heuristic itself isn't sure about, so training on them just
 * teaches the classifier to mimic ambiguity.
 */
function isTrainable(ex: LabeledExample): boolean {
  if (ex.complexity_refined) return true;
  if (ex.heuristic_score >= 0.22 && ex.heuristic_score <= 0.28) return false;
  if (ex.heuristic_score >= 0.57 && ex.heuristic_score <= 0.63) return false;
  return true;
}

// =========================================================================
// Mini-batch SGD softmax regression
// =========================================================================

/**
 * Tiny seedable PRNG (mulberry32). We need deterministic shuffling for
 * reproducible training runs across operators / CI; bringing in a real
 * RNG library is overkill.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

interface TrainHeadResult {
  weights: Float32Array;
  bias: Float32Array;
  /** Final epoch's mean cross-entropy loss on training. */
  train_loss: number;
  /** Argmax accuracy on the held-out set. */
  validation_accuracy: number;
  /** Per-class precision / recall / support. Keyed by class LABEL
   *  (the user-facing string, not the numeric index) so it's safe to
   *  read straight into artifact.validation without remapping. */
  per_class: Record<string, { precision: number | null; recall: number | null; support: number }>;
}

function trainHead(
  examples: LabeledExample[],
  validation: LabeledExample[],
  classLabels: string[],
  numBuckets: number,
  labelKey: "task_type_idx" | "complexity_idx",
  args: Args,
  rng: () => number
): TrainHeadResult {
  const numClasses = classLabels.length;
  const weights = new Float32Array(numClasses * numBuckets); // zero init
  const bias = new Float32Array(numClasses); // zero init
  const gradW = new Float32Array(numClasses * numBuckets);
  const gradB = new Float32Array(numClasses);
  const logits = new Float32Array(numClasses);
  const probs = new Float32Array(numClasses);

  let lr = args.learningRate;
  let lastLoss = 0;
  // Pre-allocated index permutation we reshuffle each epoch — avoids
  // re-allocating a few thousand-element array on every pass.
  const order = examples.map((_, i) => i);

  for (let epoch = 0; epoch < args.epochs; epoch++) {
    shuffleInPlace(order, rng);
    let epochLoss = 0;
    let batchLoss = 0;
    let batchSeen = 0;

    const flushBatch = (): void => {
      if (batchSeen === 0) return;
      const scale = lr / batchSeen;
      const l2 = args.l2;
      for (let i = 0; i < gradW.length; i++) {
        // L2: regularize toward zero each batch step.
        weights[i] -= scale * gradW[i] + lr * l2 * weights[i];
        gradW[i] = 0;
      }
      for (let c = 0; c < numClasses; c++) {
        bias[c] -= scale * gradB[c];
        gradB[c] = 0;
      }
      epochLoss += batchLoss;
      batchLoss = 0;
      batchSeen = 0;
    };

    for (const idx of order) {
      const ex = examples[idx];
      const y = ex[labelKey];
      // Forward: logits = W·x + b
      for (let c = 0; c < numClasses; c++) {
        let s = bias[c];
        const offset = c * numBuckets;
        const f = ex.features;
        for (let i = 0; i < numBuckets; i++) {
          if (f[i] !== 0) s += weights[offset + i] * f[i];
        }
        logits[c] = s;
      }
      // Softmax (in-place into `probs`).
      let maxL = -Infinity;
      for (let c = 0; c < numClasses; c++) if (logits[c] > maxL) maxL = logits[c];
      let sum = 0;
      for (let c = 0; c < numClasses; c++) {
        probs[c] = Math.exp(logits[c] - maxL);
        sum += probs[c];
      }
      const inv = sum > 0 ? 1 / sum : 0;
      for (let c = 0; c < numClasses; c++) probs[c] *= inv;

      // CE loss for this example (just for monitoring).
      const py = Math.max(probs[y], 1e-9);
      batchLoss -= Math.log(py);

      // Gradient: dL/dlogit_c = (p_c - 1{c=y});
      //           dL/dW[c,i]   = (p_c - 1{c=y}) · x_i;
      //           dL/db[c]     = (p_c - 1{c=y})
      for (let c = 0; c < numClasses; c++) {
        const err = probs[c] - (c === y ? 1 : 0);
        gradB[c] += err;
        const offset = c * numBuckets;
        const f = ex.features;
        for (let i = 0; i < numBuckets; i++) {
          if (f[i] !== 0) gradW[offset + i] += err * f[i];
        }
      }
      batchSeen++;
      if (batchSeen >= args.batchSize) flushBatch();
    }
    flushBatch();

    epochLoss /= examples.length || 1;
    lastLoss = epochLoss;
    // Simple LR decay — halve every 3 epochs. Nothing fancy; keeps
    // the late-epoch updates from overshooting once we're in the
    // basin of the loss surface.
    if ((epoch + 1) % 3 === 0) lr *= 0.5;

    if (epoch === 0 || epoch === args.epochs - 1) {
      console.log(
        `[train]   head=${labelKey === "task_type_idx" ? "task_type" : "complexity"} ` +
          `epoch=${epoch + 1}/${args.epochs} loss=${epochLoss.toFixed(4)} lr=${lr.toExponential(2)}`
      );
    }
  }

  // Validation pass — computes overall accuracy AND per-class confusion
  // counts in a single sweep. Per-class metrics (precision / recall /
  // support) surface tail-class regression that a single accuracy number
  // hides, e.g. "overall 90% but reasoning recall is 30%".
  let correct = 0;
  const tp = new Array(numClasses).fill(0);
  const fp = new Array(numClasses).fill(0);
  const fn = new Array(numClasses).fill(0);
  const support = new Array(numClasses).fill(0);
  for (const ex of validation) {
    const y = ex[labelKey];
    for (let c = 0; c < numClasses; c++) {
      let s = bias[c];
      const offset = c * numBuckets;
      const f = ex.features;
      for (let i = 0; i < numBuckets; i++) {
        if (f[i] !== 0) s += weights[offset + i] * f[i];
      }
      logits[c] = s;
    }
    let bestC = 0;
    let bestL = logits[0];
    for (let c = 1; c < numClasses; c++) {
      if (logits[c] > bestL) {
        bestL = logits[c];
        bestC = c;
      }
    }
    support[y]++;
    if (bestC === y) {
      correct++;
      tp[y]++;
    } else {
      fp[bestC]++;
      fn[y]++;
    }
  }
  const acc = validation.length > 0 ? correct / validation.length : 0;

  const per_class: Record<string, { precision: number | null; recall: number | null; support: number }> = {};
  for (let c = 0; c < numClasses; c++) {
    const label = classLabels[c];
    const precisionDenom = tp[c] + fp[c];
    const recallDenom = tp[c] + fn[c];
    per_class[label] = {
      precision: precisionDenom > 0 ? tp[c] / precisionDenom : null,
      recall: recallDenom > 0 ? tp[c] / recallDenom : null,
      support: support[c],
    };
  }

  return {
    weights,
    bias,
    train_loss: lastLoss,
    validation_accuracy: acc,
    per_class,
  };
}

/**
 * Pick a softmax-confidence threshold that keeps "wrong predictions
 * trusted" below 5% on the held-out set. The classifier hands the
 * threshold to the runtime — when softmax max < threshold, the
 * prediction is dropped and the heuristic picks up.
 *
 * Implementation: sweep candidate thresholds in 0.05 increments and
 * pick the LOWEST one whose error-among-trusted ≤ 5%. Lowest because
 * we want maximum coverage subject to the safety budget. If no
 * threshold meets the budget (very noisy classifier), we set
 * threshold = 1.01 — effectively "never trust", which keeps the
 * runtime on heuristic until the next training run improves.
 */
function calibrateThreshold(
  weights: Float32Array,
  bias: Float32Array,
  numClasses: number,
  numBuckets: number,
  validation: LabeledExample[],
  labelKey: "task_type_idx" | "complexity_idx"
): number {
  if (validation.length === 0) return 1.01; // no data → never trust
  const items = validation.map((ex) => {
    const logits = new Float32Array(numClasses);
    for (let c = 0; c < numClasses; c++) {
      let s = bias[c];
      const offset = c * numBuckets;
      const f = ex.features;
      for (let i = 0; i < numBuckets; i++) {
        if (f[i] !== 0) s += weights[offset + i] * f[i];
      }
      logits[c] = s;
    }
    let maxL = -Infinity;
    for (let c = 0; c < numClasses; c++) if (logits[c] > maxL) maxL = logits[c];
    let sum = 0;
    const probs = new Float32Array(numClasses);
    for (let c = 0; c < numClasses; c++) {
      probs[c] = Math.exp(logits[c] - maxL);
      sum += probs[c];
    }
    const inv = sum > 0 ? 1 / sum : 0;
    for (let c = 0; c < numClasses; c++) probs[c] *= inv;
    let bestC = 0;
    let bestP = probs[0];
    for (let c = 1; c < numClasses; c++) {
      if (probs[c] > bestP) {
        bestP = probs[c];
        bestC = c;
      }
    }
    return { conf: bestP, correct: bestC === ex[labelKey] };
  });

  const safetyBudget = 0.05; // ≤5% wrong-among-trusted
  // Sweep 0.30 → 0.95 in 0.05 steps. Below 0.30 there's barely any
  // signal to trust; above 0.95 we'd trust almost nothing.
  for (let thr = 0.3; thr <= 0.95 + 1e-9; thr += 0.05) {
    const trusted = items.filter((x) => x.conf >= thr);
    if (trusted.length === 0) continue;
    const wrong = trusted.filter((x) => !x.correct).length;
    const errRate = wrong / trusted.length;
    if (errRate <= safetyBudget) {
      // Round to 2 decimal places so the JSON artifact is human-friendly.
      return Math.round(thr * 100) / 100;
    }
  }
  // Couldn't find a safe threshold. Set artificially-high so the
  // runtime never trusts this head — operator should look at the
  // training output and either gather more data or tune
  // hyperparameters before relying on it.
  return 1.01;
}

// =========================================================================
// Orchestration
// =========================================================================

function preflight(args: Args): void {
  // Critical safety property: if the embedding classifier is ENABLED
  // when this script runs, the labels we derive from `classifyTask()`
  // will be the classifier's OWN predictions — leading to feedback
  // collapse on retrain. Refuse to run in that case unless the
  // operator explicitly opts out via --i-know-what-im-doing.
  if (
    process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED === "1" &&
    !args.iKnowWhatImDoing
  ) {
    fail(
      "TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED=1 in env. The training " +
        "script would derive labels from the classifier's own predictions, " +
        "which causes label drift across retrains. Either:\n" +
        "  - unset TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED for this run, OR\n" +
        "  - pass --i-know-what-im-doing if you genuinely want self-distillation."
    );
  }
  // DB-store mode requires Postgres. disk-store mode (global artifact,
  // single-tenant self-host) ALSO reads from `requests` + `ab_results`
  // so Postgres is still a must for the data load — SQLite shim doesn't
  // carry those tables with project_id / similarity columns.
  if (dbBackend !== "postgres") {
    fail(
      "this script needs Postgres (the SQLite shim doesn't carry the requests/ab_results " +
        "schema with project_id + similarity columns we read here). Point DATABASE_URL at " +
        "your gateway's Postgres before retrying."
    );
  }
  // Lookback cap is enforced server-side in loadRequests — but warn
  // here too so the operator sees it before waiting for the query.
  if (args.lookbackDays > 90) {
    console.warn(
      `[train] --lookback-days ${args.lookbackDays} requested; capping to 90 (DB safety guard).`
    );
  }
}

// =========================================================================
// Result of a single-project training run
// =========================================================================

type TrainOutcome =
  | { ok: true; kind: "promoted"; projectId: string; version: number; ttAcc: number | null; cxAcc: number | null }
  | { ok: true; kind: "dry_run"; projectId: string | null; ttAcc: number | null; cxAcc: number | null }
  | { ok: true; kind: "disk_written"; projectId: null; path: string; ttAcc: number | null; cxAcc: number | null }
  | { ok: false; kind: "skipped" | "rejected" | "failed"; projectId: string | null; reason: string };

/**
 * Train a single artifact: one project (when projectId is set) or
 * one global (when projectId is null). Pure function from (projectId,
 * args, encoder) to TrainOutcome. Orchestration (batch iteration,
 * alert dispatch) lives in `main()`.
 *
 * Returns structured outcome instead of throwing for "project has no
 * data" / "quality floor failed" — those are routine skip cases in
 * batch mode. Actual errors (DB failure, unexpected crashes) propagate
 * via reject.
 */
async function trainOne(
  projectId: string | null,
  args: Args,
  encoder: EncoderConfig
): Promise<TrainOutcome> {
  const startMs = Date.now();
  const scope = projectId ?? "<global>";

  console.log(
    `\n[train] === project=${scope} ===`
  );
  console.log(
    `[train] loading requests: lookback=${args.lookbackDays}d`
  );
  const rawRows = await loadRequests(projectId, args.lookbackDays);
  console.log(`[train]   ${rawRows.length} raw rows`);

  if (rawRows.length === 0) {
    return {
      ok: false,
      kind: "skipped",
      projectId,
      reason: "no requests in lookback window",
    };
  }

  console.log(`[train] loading shadow A/B refinements`);
  const shadows = await loadShadows(projectId, args.lookbackDays);
  console.log(`[train]   ${shadows.size} request(s) have shadow data`);

  // Encode every row. Same inner loop as the old single-mode main().
  const examples: LabeledExample[] = [];
  const tt_counts: Record<string, number> = { chat: 0, code: 0, reasoning: 0, tool_use: 0 };
  const cx_counts: Record<string, number> = { simple: 0, medium: 0, hard: 0 };
  const bucketHits = new Uint32Array(encoder.num_buckets);
  let dropped = 0;
  let refinedRows = 0;
  for (const row of rawRows) {
    const body = row.request_body as OpenAIChatRequest;
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
      dropped++;
      continue;
    }
    const labels = deriveLabels(body, shadows.get(row.id));
    if (!labels) {
      dropped++;
      continue;
    }
    if (labels.refined) refinedRows++;
    const features = encodeRequest(body, encoder);
    let hasFeature = false;
    for (let i = 0; i < features.length; i++) {
      if (features[i] !== 0) {
        hasFeature = true;
        bucketHits[i]++;
      }
    }
    if (!hasFeature) {
      dropped++;
      continue;
    }
    examples.push({
      features,
      task_type_idx: TASK_TYPES.indexOf(labels.task_type),
      complexity_idx: COMPLEXITY.indexOf(labels.complexity),
      complexity_refined: labels.refined,
      heuristic_score: complexityScore(body),
    });
    tt_counts[labels.task_type] = (tt_counts[labels.task_type] ?? 0) + 1;
    cx_counts[labels.complexity] = (cx_counts[labels.complexity] ?? 0) + 1;
  }

  logCollisionHotspots(bucketHits, examples.length);

  console.log(
    `[train]   ${examples.length} usable examples, ${dropped} dropped, ` +
      `${refinedRows} refined by shadows`
  );
  console.log(`[train]   task_type counts: ${JSON.stringify(tt_counts)}`);
  console.log(`[train]   complexity counts: ${JSON.stringify(cx_counts)}`);

  if (examples.length < args.minRows) {
    return {
      ok: false,
      kind: "skipped",
      projectId,
      reason: `only ${examples.length} usable rows < min_rows=${args.minRows}`,
    };
  }

  // 80/20 chronological split, same semantics as the old main().
  const splitAt = Math.max(1, Math.floor(examples.length * 0.8));
  const allTrain = examples.slice(0, splitAt);
  const validation = examples.slice(splitAt);
  const train = allTrain.filter(isTrainable);
  console.log(
    `[train] split: train=${train.length} (after ambiguity filter, raw=${allTrain.length}), validation=${validation.length}`
  );

  if (train.length === 0) {
    return {
      ok: false,
      kind: "skipped",
      projectId,
      reason: "no trainable rows remain after ambiguity filter",
    };
  }

  const rng = mulberry32(args.seed);

  console.log(`[train] training task_type head (${TASK_TYPES.length} classes)`);
  const ttRes = trainHead(
    train,
    validation,
    TASK_TYPES,
    encoder.num_buckets,
    "task_type_idx",
    args,
    rng
  );

  console.log(`[train] training complexity head (${COMPLEXITY.length} classes)`);
  const cxRes = trainHead(
    train,
    validation,
    COMPLEXITY,
    encoder.num_buckets,
    "complexity_idx",
    args,
    rng
  );

  console.log(`[train] calibrating confidence thresholds`);
  const ttThr = calibrateThreshold(
    ttRes.weights,
    ttRes.bias,
    TASK_TYPES.length,
    encoder.num_buckets,
    validation,
    "task_type_idx"
  );
  const cxThr = calibrateThreshold(
    cxRes.weights,
    cxRes.bias,
    COMPLEXITY.length,
    encoder.num_buckets,
    validation,
    "complexity_idx"
  );

  console.log(
    `[train]   task_type:  acc=${ttRes.validation_accuracy.toFixed(3)} ` +
      `loss=${ttRes.train_loss.toFixed(3)} threshold=${ttThr.toFixed(2)}`
  );
  logPerClass("task_type", ttRes.per_class);
  console.log(
    `[train]   complexity: acc=${cxRes.validation_accuracy.toFixed(3)} ` +
      `loss=${cxRes.train_loss.toFixed(3)} threshold=${cxThr.toFixed(2)}`
  );
  logPerClass("complexity", cxRes.per_class);

  const artifact: ClassifierArtifact = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    model_version: `v1.${Date.now()}`,
    generated_at: new Date().toISOString(),
    trained_on: {
      rows: examples.length,
      lookback_days: Math.min(args.lookbackDays, 90),
      project_id: projectId,
      task_type_counts: tt_counts,
      complexity_counts: cx_counts,
    },
    encoder,
    task_type: serializeHead(
      TASK_TYPES,
      ttRes.weights,
      ttRes.bias,
      ttThr
    ) as ClassifierHead<TaskType>,
    complexity: serializeHead(
      COMPLEXITY,
      cxRes.weights,
      cxRes.bias,
      cxThr
    ) as ClassifierHead<ComplexityBucket>,
    validation: {
      task_type_accuracy: validation.length > 0 ? ttRes.validation_accuracy : null,
      complexity_accuracy: validation.length > 0 ? cxRes.validation_accuracy : null,
      task_type_per_class: validation.length > 0 ? ttRes.per_class : undefined,
      complexity_per_class: validation.length > 0 ? cxRes.per_class : undefined,
      n_validation: validation.length,
    },
  };

  const ttAcc = artifact.validation.task_type_accuracy;
  const cxAcc = artifact.validation.complexity_accuracy;

  const store = resolveStore(args, projectId);

  if (args.dryRun) {
    const sizeLabel =
      store === "disk"
        ? `would have written ${args.output}, ${approximateSizeKb(artifact, args.pretty)}KB`
        : `would have written project_embedding_classifiers row for ${scope}, ${approximateSizeKb(artifact, args.pretty)}KB`;
    console.log(`[train] --dry-run: not writing. (${sizeLabel})`);
    return { ok: true, kind: "dry_run", projectId, ttAcc, cxAcc };
  }

  if (store === "disk") {
    const outDir = path.dirname(args.output);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const serialized = args.pretty
      ? JSON.stringify(artifact, null, 2)
      : JSON.stringify(artifact);
    writeFileSync(args.output, serialized + "\n");
    console.log(
      `[train] wrote ${args.output} (${approximateSizeKb(artifact, args.pretty)}KB) ` +
        `in ${((Date.now() - startMs) / 1000).toFixed(1)}s.`
    );
    console.log(
      `[train] enable at runtime with TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED=1 ` +
        `— the gateway hot-reload watcher picks it up without a restart.`
    );
    // Global-scope pg_notify for the file-watch / global-reload channel.
    if (dbBackend === "postgres") {
      await notifyEmbeddingReload({
        model_version: artifact.model_version,
        project_id: null,
        generated_at: artifact.generated_at,
      });
    }
    return {
      ok: true,
      kind: "disk_written",
      projectId: null,
      path: args.output,
      ttAcc,
      cxAcc,
    };
  }

  // db-store path: requires a project. --store=auto catches `db` with
  // null projectId (e.g. someone passes --store=db without --project),
  // so reject that here.
  if (!projectId) {
    return {
      ok: false,
      kind: "failed",
      projectId: null,
      reason:
        "--store=db requires a project. Pass --project <uuid> or use --store=disk.",
    };
  }

  // Quality floor — if either head is below the floor, record the row
  // as 'rejected' and skip promotion. Operator sees it in the history
  // table; the prior 'active' row keeps serving.
  const floorMsg = checkQualityFloor(args, ttAcc, cxAcc);

  let promotedVersion = 0;
  try {
    await sql.begin(async (tx) => {
      const lockRows = await tx<{ id: string }[]>`
        SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE
      `;
      if (lockRows.length === 0) {
        throw new Error(`project ${projectId} not found`);
      }
      const versionRow = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM project_embedding_classifiers
        WHERE project_id = ${projectId}
      `;
      const nextVersion = versionRow[0]?.next_version ?? 1;
      promotedVersion = nextVersion;

      const status = floorMsg ? "rejected" : "pending";
      const notes =
        args.notes ??
        (floorMsg
          ? `Rejected by quality floor: ${floorMsg}`
          : renderDefaultNotes(artifact));

      await tx`
        INSERT INTO project_embedding_classifiers (
          project_id, version, status, payload, source, sample_count,
          task_type_accuracy, complexity_accuracy, notes
        ) VALUES (
          ${projectId},
          ${nextVersion},
          ${status},
          ${tx.json(artifact as unknown as Parameters<typeof tx.json>[0])},
          ${args.source},
          ${examples.length},
          ${ttAcc},
          ${cxAcc},
          ${notes}
        )
      `;

      if (!floorMsg) {
        // Demote prior active → superseded, promote new pending → active,
        // all inside the same transaction so reads of status='active'
        // never see two rows.
        await tx`
          UPDATE project_embedding_classifiers
          SET status = 'superseded'
          WHERE project_id = ${projectId}
            AND status = 'active'
        `;
        await tx`
          UPDATE project_embedding_classifiers
          SET status = 'active', activated_at = NOW()
          WHERE project_id = ${projectId}
            AND version = ${nextVersion}
        `;
      }
    });
  } catch (err) {
    return {
      ok: false,
      kind: "failed",
      projectId,
      reason: `transaction failed: ${(err as Error).message}`,
    };
  }

  if (floorMsg) {
    console.log(
      `[train]   REJECTED v${promotedVersion} (below quality floor): ${floorMsg}`
    );
    console.log(
      `[train]   prior 'active' row kept serving; row written as status='rejected' for forensics.`
    );
    return {
      ok: false,
      kind: "rejected",
      projectId,
      reason: floorMsg,
    };
  }

  console.log(
    `[train]   promoted v${promotedVersion} (status=active) in ${((Date.now() - startMs) / 1000).toFixed(1)}s.`
  );

  // Per-project pg_notify fan-out. The cache loader in
  // `embedding-classifier-loader.ts` drops the cache entry for this
  // project on every subscribing gateway replica within milliseconds.
  await notifyEmbeddingReload({
    project_id: projectId,
    version: promotedVersion,
    model_version: artifact.model_version,
  });

  return {
    ok: true,
    kind: "promoted",
    projectId,
    version: promotedVersion,
    ttAcc,
    cxAcc,
  };
}

/**
 * Decide where the artifact should land given (args.store, projectId).
 * 'auto' → 'db' when we have a project, else 'disk'. Explicit values
 * pass through unchanged. Invalid combos (db without project) are
 * detected at the call site with a useful error message.
 */
function resolveStore(args: Args, projectId: string | null): "db" | "disk" {
  if (args.store === "auto") return projectId ? "db" : "disk";
  return args.store;
}

/**
 * Return a human-readable reason string when the artifact is below the
 * configured floor, else null. Applied only in db-store mode — disk
 * mode is single-tenant and operators explicitly opted into an
 * unconditional write.
 */
function checkQualityFloor(
  args: Args,
  ttAcc: number | null,
  cxAcc: number | null
): string | null {
  if (args.minTaskTypeAccuracy <= 0 && args.minComplexityAccuracy <= 0) {
    return null;
  }
  if (ttAcc == null || cxAcc == null) {
    return "no validation data (both accuracies are null)";
  }
  const reasons: string[] = [];
  if (ttAcc < args.minTaskTypeAccuracy) {
    reasons.push(
      `task_type_accuracy ${ttAcc.toFixed(3)} < floor ${args.minTaskTypeAccuracy.toFixed(2)}`
    );
  }
  if (cxAcc < args.minComplexityAccuracy) {
    reasons.push(
      `complexity_accuracy ${cxAcc.toFixed(3)} < floor ${args.minComplexityAccuracy.toFixed(2)}`
    );
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

/**
 * Compose the default row `notes` from training provenance. Kept short
 * enough to render in a dashboard cell without truncation overflow.
 */
function renderDefaultNotes(artifact: ClassifierArtifact): string {
  const ttAcc = artifact.validation.task_type_accuracy;
  const cxAcc = artifact.validation.complexity_accuracy;
  const rows = artifact.trained_on.rows;
  return (
    `Trained from ${rows} rows over ${artifact.trained_on.lookback_days}d. ` +
    `Validation: task_type=${ttAcc?.toFixed(2) ?? "n/a"}, complexity=${cxAcc?.toFixed(2) ?? "n/a"}. ` +
    `Encoder: ${artifact.encoder.num_buckets}-bucket, ${artifact.encoder.ngram_size}-gram.`
  );
}

/**
 * Emit `tokensmart_embedding_reload` for the live gateway replicas to
 * drop their caches. Best-effort — a NOTIFY failure doesn't undo the
 * successful DB write. Idempotent; safe to call multiple times.
 */
async function notifyEmbeddingReload(
  payload: Record<string, unknown>
): Promise<void> {
  if (dbBackend !== "postgres") return;
  try {
    const json = JSON.stringify(payload);
    await sql`SELECT pg_notify('tokensmart_embedding_reload', ${json})`;
    const scope = payload.project_id ? `project=${payload.project_id}` : "global";
    console.log(`[train] emitted pg_notify tokensmart_embedding_reload (${scope})`);
  } catch (err) {
    console.warn(
      `[train] pg_notify failed (${(err as Error).message}) — live reload may need gateway restart`
    );
  }
}

async function listLearningEnabledProjects(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM projects WHERE learning_enabled = TRUE
  `;
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  preflight(args);

  // Build the encoder config from CLI overrides, starting from the v2
  // multilingual defaults (or v1 legacy when --legacy-v1-encoder is set).
  // The artifact persists the resolved config so inference matches train.
  const baseEncoder = args.legacyV1Encoder
    ? LEGACY_V1_ENCODER_CONFIG
    : DEFAULT_ENCODER_CONFIG;
  const encoder: EncoderConfig = {
    ...baseEncoder,
    ...(args.numBuckets != null ? { num_buckets: args.numBuckets } : {}),
    ...(args.ngramSize != null ? { ngram_size: args.ngramSize } : {}),
    ...(args.maxChars != null ? { max_chars: args.maxChars } : {}),
  };
  console.log(
    `[train] encoder: num_buckets=${encoder.num_buckets}, ngram_size=${encoder.ngram_size}, max_chars=${encoder.max_chars}, v2=${args.legacyV1Encoder ? "off" : "on"}`
  );
  const effectiveStore = resolveStore(args, args.project ?? (args.allEnabled ? "<per-project>" : null));
  console.log(
    `[train] mode=${args.allEnabled ? "batch" : args.project ? "single-project" : "global"} store=${effectiveStore}`
  );

  // Resolve which projects to train.
  let projectIds: (string | null)[];
  if (args.allEnabled) {
    const enabled = await listLearningEnabledProjects();
    if (enabled.length === 0) {
      console.log("[train] no projects with learning_enabled = TRUE.");
      return;
    }
    console.log(`[train] ${enabled.length} project(s) with learning enabled.`);
    projectIds = enabled;
  } else if (args.project) {
    projectIds = [args.project];
  } else {
    projectIds = [null]; // global / disk mode
  }

  let ok = 0;
  let skipped = 0;
  let rejected = 0;
  let failed = 0;

  for (const projectId of projectIds) {
    let outcome: TrainOutcome;
    try {
      outcome = await trainOne(projectId, args, encoder);
    } catch (err) {
      outcome = {
        ok: false,
        kind: "failed",
        projectId,
        reason: `uncaught: ${(err as Error).message}`,
      };
    }

    if (outcome.ok) {
      ok++;
    } else if (outcome.kind === "skipped") {
      console.log(`[train]   skipped: ${outcome.reason}`);
      skipped++;
    } else if (outcome.kind === "rejected") {
      rejected++;
      if (!args.dryRun && outcome.projectId) {
        // Alert on quality-floor reject — not a crash, but the operator
        // wants to know that today's retrain was below bar.
        await dispatchAlertSafe(outcome.projectId, "embedding_retrain_rejected", {
          reason: outcome.reason,
          source: args.source,
        });
      }
    } else {
      console.error(`[train]   FAILED: ${outcome.reason}`);
      failed++;
      if (!args.dryRun && outcome.projectId) {
        await dispatchAlertSafe(outcome.projectId, "embedding_retrain_failed", {
          reason: outcome.reason,
          source: args.source,
          lookback_days: args.lookbackDays,
        });
      }
    }
  }

  console.log(
    `\n[train] done: ${ok} promoted/written, ${skipped} skipped, ${rejected} rejected, ${failed} failed.`
  );
  if (failed > 0) process.exit(2);
}

async function dispatchAlertSafe(
  projectId: string,
  event: string,
  metadata: Record<string, unknown>
): Promise<void> {
  // The alerts module's `dispatchAlert` expects a specific AlertEventType
  // union. For now we use the closest existing kind ('retrain_failed')
  // for both embedding failures and rejections, with a `kind` in
  // metadata so downstream handlers can distinguish if needed. A future
  // patch can extend the AlertEventType union to include
  // 'embedding_retrain_failed' / 'embedding_retrain_rejected' as
  // first-class events.
  try {
    await dispatchAlert(projectId, "retrain_failed", {
      subsystem: "embedding_classifier",
      kind: event,
      ...metadata,
    });
  } catch (err) {
    console.warn(
      `[train]   alert dispatch failed (non-fatal): ${(err as Error).message}`
    );
  }
}

function serializeHead<C extends string>(
  classes: C[],
  weights: Float32Array,
  bias: Float32Array,
  threshold: number
): ClassifierHead<C> {
  // Round to 6 sig figs to keep artifact JSON readable + small. The
  // accuracy hit from rounding 32-bit floats to 6 sig figs is in the
  // noise compared to weak-label noise.
  const round = (x: number): number => {
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 1e6) / 1e6;
  };
  return {
    classes,
    weights: Array.from(weights, round),
    bias: Array.from(bias, round),
    confidence_threshold: threshold,
  };
}

function approximateSizeKb(a: ClassifierArtifact, pretty = false): string {
  const serialized = pretty ? JSON.stringify(a, null, 2) : JSON.stringify(a);
  return (serialized.length / 1024).toFixed(1);
}

/**
 * Flag hash-bucket collision hotspots. Prints the max / mean / stddev of
 * per-bucket hit counts plus the top-10 buckets. An operator sees:
 *
 *   - max/mean ≤ ~5× — bucket load is healthy, num_buckets is fine.
 *   - max/mean ≥ ~10× — a handful of buckets are absorbing the bulk of
 *     traffic. Either the tenant has one dominant n-gram (e.g. a
 *     specific tool name in every prompt) OR the bucket space is too
 *     small. Try `--num-buckets 8192` or 16384.
 *   - max/mean ≥ ~50× — almost certainly pathological. The classifier
 *     will fit the outliers and under-weight the rest.
 *
 * We intentionally surface this only as a print line — storing it in
 * the artifact would burden routine training. An operator who wants to
 * track it over time can pipe the training log into monitoring.
 */
function logCollisionHotspots(bucketHits: Uint32Array, rows: number): void {
  if (rows === 0) return;
  let nonzero = 0;
  let maxH = 0;
  let sum = 0;
  for (let i = 0; i < bucketHits.length; i++) {
    const h = bucketHits[i];
    if (h > 0) nonzero++;
    if (h > maxH) maxH = h;
    sum += h;
  }
  if (nonzero === 0) return;
  const mean = sum / nonzero;
  // Std dev (only over non-zero buckets — zero buckets are structural
  // emptiness, not collision signal).
  let sq = 0;
  for (let i = 0; i < bucketHits.length; i++) {
    if (bucketHits[i] > 0) {
      const d = bucketHits[i] - mean;
      sq += d * d;
    }
  }
  const stddev = Math.sqrt(sq / nonzero);
  const ratio = mean > 0 ? maxH / mean : 0;
  console.log(
    `[train]   bucket histogram: filled=${nonzero}/${bucketHits.length} ` +
      `(${((nonzero / bucketHits.length) * 100).toFixed(0)}%), ` +
      `max=${maxH}, mean=${mean.toFixed(1)}, stddev=${stddev.toFixed(1)}, ` +
      `max/mean=${ratio.toFixed(1)}×`
  );
  if (ratio > 10) {
    console.log(
      `[train]   ⚠ collision hotspot: top bucket hit ${ratio.toFixed(1)}× mean — ` +
        `consider --num-buckets ${bucketHits.length * 2} or --num-buckets ${bucketHits.length * 4}`
    );
    const indexed: { idx: number; hits: number }[] = [];
    for (let i = 0; i < bucketHits.length; i++) {
      if (bucketHits[i] > 0) indexed.push({ idx: i, hits: bucketHits[i] });
    }
    indexed.sort((a, b) => b.hits - a.hits);
    const top = indexed
      .slice(0, 10)
      .map((x) => `#${x.idx}=${x.hits}`)
      .join(" ");
    console.log(`[train]   top-10 buckets: ${top}`);
  }
}

/**
 * Print per-class precision / recall / support in a compact line, so an
 * operator reviewing a training run can spot tail-class regression at a
 * glance without cracking the artifact JSON open. Formatted the same way
 * scikit-learn's `classification_report` truncates — precision + recall
 * to 2 decimals, support as integer.
 */
function logPerClass(
  head: "task_type" | "complexity",
  per_class: Record<
    string,
    { precision: number | null; recall: number | null; support: number }
  >
): void {
  const entries = Object.entries(per_class);
  if (entries.length === 0) return;
  const rendered = entries
    .map(([label, m]) => {
      const p = m.precision == null ? "n/a" : m.precision.toFixed(2);
      const r = m.recall == null ? "n/a" : m.recall.toFixed(2);
      return `${label}=(p=${p},r=${r},n=${m.support})`;
    })
    .join("  ");
  console.log(`[train]             ${head.padEnd(10)} per-class: ${rendered}`);
}

await main()
  .catch((err) => {
    console.error("train-embedding-classifier: fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // ignore
    }
  });
