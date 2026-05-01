/**
 * Embedding-based task classifier.
 *
 * Why this exists
 * ---------------
 * The shipped heuristic classifier (`policy/task-classifier.ts`) is
 * regex-on-keywords plus a handful of hand-tuned thresholds. It works,
 * but it's fundamentally "routing intuition" — it can't see novel
 * phrasings, languages it wasn't authored against, or domain-specific
 * vocabulary. Two failure modes we keep hitting in production:
 *
 *   - Chinese / Japanese / mixed-language asks that obviously want
 *     code or reasoning, but match neither the English CODE_KEYWORDS
 *     nor REASONING_KEYWORDS regex.
 *   - "Mostly-trivial" turns peppered with a single trigger word
 *     ("can you analyze this output?") that escalate to reasoning
 *     even when the user is doing throwaway debugging.
 *
 * The fix is the textbook fastText recipe: hash character n-grams
 * into a fixed-size feature vector, then a linear softmax on top of
 * those features per class. Two heads — `task_type` and `complexity`.
 * Trained from real `requests` rows under weak supervision (the
 * heuristic provides initial labels, shadow A/B `similarity` data
 * sharpens complexity labels).
 *
 * Hot-path constraints
 * --------------------
 * Inference must be SUB-MILLISECOND (the user's "<20ms latency" target
 * is a 20× safety margin on what we actually achieve here). To get
 * there we:
 *
 *   1. Encode with a HASH TRICK — no vocabulary table, no per-token
 *      lookup, no malloc per word. A single pass over text → write
 *      directly into a pre-existing Float32Array.
 *   2. Predict with a single dense matrix multiply per head. For
 *      4096 buckets × 4 task_type classes that's ~16k mults; bun's
 *      JIT inlines this into a tight loop.
 *   3. NEVER ship a real embedding model (no ONNX runtime, no
 *      tokenizer download, no model weights >1MB). The trained
 *      artifact is ~70KB of JSON — fits in process memory trivially.
 *
 * What we explicitly DON'T do
 * ---------------------------
 * - No per-request LLM call (that's `TOKENSMART_CLASSIFIER_MODEL`'s job
 *   and that path is preserved).
 * - No fine-tuned BERT (200MB+ of weights, ONNX runtime startup cost,
 *   wrong abstraction for the routing decision).
 * - No GPU. No threadpool. The classifier runs inline on the request
 *   coroutine; sub-ms means it won't even show up in flame graphs.
 *
 * Artifact format
 * ---------------
 * One JSON file. Loaded once at boot (memoized like baseline-policy
 * does), absent file = fall back silently to heuristic. The format
 * carries enough metadata for an operator to debug a misroute by
 * `cat`-ing the file: training row count, lookback window, schema
 * version, encoder params, per-class weights + bias.
 */

import type { OpenAIChatRequest } from "../providers/openai";
import type { TaskType, ComplexityBucket } from "./types";
// v0.6.7 — share extraction with the heuristic classifier so multi-modal
// content arrays + harness-prepended wrappers behave identically across
// both code paths. The import direction creates a circular reference with
// `task-classifier.ts` (which already imports from this file), but neither
// side reads the imported binding at module-init time — both call them
// only inside request-handling functions, so ESM partial-init resolves
// them correctly by use time.
import { extractTextFromContent, extractUserIntent } from "./task-classifier";

// =========================================================================
// Encoder — character n-gram hash trick
// =========================================================================

/** Default feature dimensionality. 4096 is a sweet spot: small enough
 *  that artifact JSON stays under 100KB even with two heads, big enough
 *  that hash collisions don't dominate accuracy. */
export const DEFAULT_NUM_BUCKETS = 4096;

/** Character n-gram size. 3 (trigrams) is FastText's standard pick —
 *  it captures enough morphology to recognize "function", "analyze",
 *  "测试", and "推導" without exploding feature count. */
export const DEFAULT_NGRAM_SIZE = 3;

/** Cap input text at this many characters before encoding. Prevents
 *  a 50k-char system prompt + tools dump from dominating the feature
 *  vector for a one-line user ask. The HEURISTIC and the EMBEDDING
 *  classifier both look at the LAST USER MESSAGE only — same input
 *  contract — so this cap is on the user text alone. */
const DEFAULT_MAX_CHARS = 4000;

/** FNV-1a 32-bit. Cheap, deterministic, no crypto-grade requirement —
 *  we just need a uniformly-distributed bucket assignment. Inlined into
 *  the encoder loop so we don't pay function-call overhead per trigram. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime is 16777619; expressed as ((h << 24) + (h << 8) + ...)
    // for hot-path speed without BigInt.
    h = Math.imul(h, 0x01000193);
  }
  // Math.imul keeps the result a signed 32-bit int — convert to unsigned
  // for use as an unsigned bucket index.
  return h >>> 0;
}

export interface EncoderConfig {
  num_buckets: number;
  ngram_size: number;
  /** Lowercase before hashing. Always true in v1 — script differences
   *  (CJK, code-style upper case) are noise for routing decisions. */
  lowercase: boolean;
  /** Max chars of input to consider. */
  max_chars: number;

  // ===================================================================
  // v2 multilingual robustness options (all optional — loading an old
  // schema_version=1 artifact with these fields absent preserves exact
  // v1 encoding behavior, so existing trained artifacts keep working).
  // NEW artifacts produced by `bun run train-embedding-classifier`
  // default all four to ON — measurable win on CJK / mixed-language
  // traffic, zero-impact on ASCII-only traffic (NFKC + whitespace
  // collapse are no-ops on clean ASCII input).
  // ===================================================================

  /** Apply Unicode NFKC normalization before lowercasing. Unifies
   *  equivalent forms ("café" as `e + U+0301` vs pre-composed `é`) and
   *  folds width / compatibility variants (fullwidth ASCII → halfwidth,
   *  "ｈｅｌｌｏ" → "hello"). No-op on pure ASCII. */
  normalize_nfkc?: boolean;

  /** Strip zero-width joiners / non-joiners / word-joiner / BOM /
   *  control chars (keep ordinary whitespace). These are adversarial
   *  characters that a bad actor can sprinkle to evade regex-based
   *  classifiers and would just pollute the feature vector otherwise. */
  strip_zero_width_and_control?: boolean;

  /** Collapse runs of whitespace (spaces, tabs, newlines) to a single
   *  space so `"hello\n\nworld"` and `"hello world"` produce identical
   *  trigrams. Preserves the count signal (one boundary) without
   *  multiplying distinct n-grams. */
  collapse_whitespace?: boolean;

  /** ALSO emit bigrams for runs of CJK characters. Trigrams of CJK
   *  often span word boundaries (2-char words are the norm in Chinese
   *  / Japanese), so a bigram layer gives the classifier direct access
   *  to word-like signal. ASCII text is unaffected. */
  cjk_bigrams?: boolean;
}

export const DEFAULT_ENCODER_CONFIG: EncoderConfig = {
  num_buckets: DEFAULT_NUM_BUCKETS,
  ngram_size: DEFAULT_NGRAM_SIZE,
  lowercase: true,
  max_chars: DEFAULT_MAX_CHARS,
  normalize_nfkc: true,
  strip_zero_width_and_control: true,
  collapse_whitespace: true,
  cjk_bigrams: true,
};

/**
 * v1 (pre-multilingual) encoder defaults. Kept exported so existing
 * callers who pin exact v1 behavior (tests, experiments, artifact
 * reloads) have a single named constant to reference. Also what
 * `encodeText` falls back to when it sees a loaded artifact with the
 * v2 flags absent (undefined = treat as v1).
 */
export const LEGACY_V1_ENCODER_CONFIG: EncoderConfig = {
  num_buckets: DEFAULT_NUM_BUCKETS,
  ngram_size: DEFAULT_NGRAM_SIZE,
  lowercase: true,
  max_chars: DEFAULT_MAX_CHARS,
  normalize_nfkc: false,
  strip_zero_width_and_control: false,
  collapse_whitespace: false,
  cjk_bigrams: false,
};

// ===========================================================================
// v2 preprocessing helpers
// ===========================================================================

/**
 * Characters we strip as "nothing to see here, go away":
 *   - Zero-width joiner / non-joiner (U+200C, U+200D) — emoji/agglutinative
 *     glue, nothing for trigram routing to learn from.
 *   - Zero-width space (U+200B), word joiner (U+2060) — invisible layout.
 *   - Directional marks LRM / RLM (U+200E, U+200F) — classic homograph /
 *     phishing vector, also pollute trigrams invisibly.
 *   - BOM / ZWNBSP (U+FEFF) — Windows text-file artifact.
 *   - Variation selectors (U+FE00–U+FE0F) — emoji variant modifiers.
 *   - Directional / isolate formatting (U+202A–U+202E, U+2066–U+2069) — RTL
 *     overrides that can visually reorder substrings.
 *   - C0 / C1 control chars (U+0000–U+001F except \t \n \r; U+007F–U+009F).
 *     We KEEP \t \n \r here — `collapse_whitespace` handles them below.
 *
 * Single regex (one pass) so this hot-path helper doesn't pay multiple
 * string rebuilds.
 */
const ZERO_WIDTH_AND_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2060\uFEFF\uFE00-\uFE0F\u202A-\u202E\u2066-\u2069]/g;

const WHITESPACE_RUN_RE = /\s+/g;

/**
 * CJK-ish unicode ranges we emit bigrams for. Not exhaustive — we cover
 * the 99% path:
 *   - CJK Unified Ideographs (U+4E00–U+9FFF): most Chinese / Japanese kanji
 *   - CJK Extension A (U+3400–U+4DBF)
 *   - Hiragana (U+3040–U+309F) + Katakana (U+30A0–U+30FF): Japanese kana
 *   - Hangul syllables (U+AC00–U+D7AF): Korean
 *
 * Rare extensions (B–F, compatibility ideographs) are skipped; they'd
 * widen the code without adding much value for routing classification.
 */
function isCjkChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0xac00 && c <= 0xd7af)
  );
}

/**
 * Apply v2 preprocessing steps. Returns the cleaned string. Order matters:
 *   1. NFKC — folds compatibility / width variants BEFORE any other cleanup
 *      so subsequent passes see canonical forms.
 *   2. Zero-width / control strip — removes adversarial / layout chars.
 *   3. Whitespace collapse — normalizes multi-space / newline runs so
 *      `"hello\n\nworld"` and `"hello world"` produce the same trigrams.
 *
 * Each step is a no-op when its flag is off, matching v1 behavior
 * bit-for-bit on existing artifacts.
 */
function preprocessText(raw: string, cfg: EncoderConfig): string {
  let out = raw;
  if (cfg.normalize_nfkc) {
    try {
      out = out.normalize("NFKC");
    } catch {
      // Malformed input — keep the raw string, same as other defensive
      // branches in this module. Never crash the hot path over a
      // hostile encoding.
    }
  }
  if (cfg.strip_zero_width_and_control) {
    out = out.replace(ZERO_WIDTH_AND_CONTROL_RE, "");
  }
  if (cfg.collapse_whitespace) {
    out = out.replace(WHITESPACE_RUN_RE, " ").trim();
  }
  return out;
}

/**
 * Encode a string into a fixed-dim L2-normalized feature vector.
 *
 * Pipeline:
 *   1. Truncate + lowercase.
 *   2. Pad the text with one boundary char on each side so the first
 *      and last n-grams aren't degenerate (a 1-char text would otherwise
 *      produce zero features).
 *   3. Slide an n-gram window across, hash each n-gram, increment that
 *      bucket. Plus we add a special "BIAS" feature in bucket 0 that's
 *      always 1.0 — gives the linear classifier an effective constant
 *      term per class without complicating the weight schema. Wait, no
 *      — we keep the bias as an explicit per-class scalar; bucket 0
 *      is a real n-gram bucket. (See predict() for where bias is
 *      applied.)
 *   4. Append structural binary features (length-bucket, has-tools,
 *      multi-turn) at the END of the vector by hashing distinguishable
 *      synthetic tokens. This lets the classifier learn that "very
 *      long prompt with tools" is structurally different from "short
 *      bare ask" without us needing a separate feature pipeline.
 *   5. L2-normalize. The dot product with the weight vector then
 *      becomes scale-invariant — a 50-char prompt and a 500-char
 *      prompt about the same topic have similar feature directions,
 *      which is what we want.
 *
 * The output Float32Array length always equals `cfg.num_buckets`.
 */
export function encodeText(
  rawText: string,
  cfg: EncoderConfig = DEFAULT_ENCODER_CONFIG
): Float32Array {
  const out = new Float32Array(cfg.num_buckets);
  if (!rawText) return out;

  // v2 preprocessing (no-op when flags are off — byte-identical to v1).
  // Applied BEFORE the length cap so that a hostile 50k-byte input
  // padded with zero-width junk doesn't eat our 4000-char budget.
  const pre = preprocessText(rawText, cfg);
  let text = pre.length > cfg.max_chars ? pre.slice(0, cfg.max_chars) : pre;
  if (cfg.lowercase) text = text.toLowerCase();
  // Boundary character — keeps short-text features from being empty AND
  // lets the model learn "starts with `def`" vs "contains `def`" via
  // distinct trigrams (`<de` vs `def`).
  const padded = `<${text}>`;

  const n = cfg.ngram_size;
  if (padded.length < n) {
    // Single short n-gram — emit it once, no slide.
    const idx = fnv1a32(padded) % cfg.num_buckets;
    out[idx] += 1;
  } else {
    for (let i = 0; i <= padded.length - n; i++) {
      const gram = padded.substring(i, i + n);
      const idx = fnv1a32(gram) % cfg.num_buckets;
      out[idx] += 1;
    }
  }

  // CJK bigram supplement (v2). Trigrams of CJK chars typically span word
  // boundaries — most meaningful Chinese / Japanese words are 2 characters.
  // Emit a bigram for every adjacent pair where BOTH chars are CJK so the
  // classifier gets direct word-level signal for those scripts. We prefix
  // bigrams with a single-char marker so they hash into different buckets
  // than any equally-spelled trigram would — no unintended collision.
  if (cfg.cjk_bigrams && text.length >= 2) {
    for (let i = 0; i < text.length - 1; i++) {
      const a = text[i];
      const b = text[i + 1];
      if (isCjkChar(a) && isCjkChar(b)) {
        const bigram = `#${a}${b}`;
        const idx = fnv1a32(bigram) % cfg.num_buckets;
        out[idx] += 1;
      }
    }
  }

  // L2 normalize.
  let sumSq = 0;
  for (let i = 0; i < out.length; i++) sumSq += out[i] * out[i];
  if (sumSq > 0) {
    const inv = 1 / Math.sqrt(sumSq);
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  }
  return out;
}

/**
 * Same as `encodeText` but takes a full `OpenAIChatRequest` and applies
 * the same input-extraction policy as the heuristic classifier (last
 * user message, JSON-stringified content for non-string).
 *
 * Centralizing this here keeps train and infer using EXACTLY the same
 * input string — a divergence here would silently break accuracy.
 */
export function encodeRequest(
  body: OpenAIChatRequest,
  cfg: EncoderConfig = DEFAULT_ENCODER_CONFIG
): Float32Array {
  const text = extractLastUserText(body);
  // Append a few structural pseudo-tokens so the classifier can
  // condition on the agent's wire shape too. We hash them with a
  // distinct prefix so they collide with real n-grams only by chance.
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const msgCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const lengthBucket =
    text.length < 30 ? "tiny" : text.length < 200 ? "short" : text.length < 1000 ? "med" : "long";
  const structural = [
    `__tools_${tools ? "1" : "0"}__`,
    `__multi_${msgCount >= 5 ? "1" : "0"}__`,
    `__len_${lengthBucket}__`,
  ];
  // Prepend structural tokens so they get included in the hash sweep.
  // (We append them WITH a space separator so trigrams that span the
  // boundary stay nonsense and the structural signal lives in
  // dedicated buckets.)
  return encodeText(`${structural.join(" ")} ${text}`, cfg);
}

// v0.6.7 — closes the v0.6.6 follow-up. This file now uses the SAME
// extraction the heuristic classifier (`task-classifier.ts`) uses:
//   1. extractTextFromContent peels OpenAI vision-mode content arrays
//      `[{type:"text",text:"..."}]` into the actual text instead of
//      JSON.stringify-ing the whole wrapper.
//   2. extractUserIntent strips noise prefixes (timestamps, bracket
//      tags, XML system_context fences) AND the wrapper-in-user-
//      message pattern (multi-paragraph wrapper + short trailing
//      intent), under the same code-fence + 80-char-tail safety
//      guards.
//
// Because the encoder's hash buckets are conditioned on the EXACT
// strings the trainer saw, switching extraction at inference time
// would degrade accuracy unless we also force a retrain. We pair this
// change with a `ClassifierArtifact.schema_version` bump from 1 → 2
// (see below), so the loader REJECTS pre-v0.6.7 artifacts with a
// clear "force retrain" message instead of serving stale predictions.
//
// Operators with an active embedding-classifier artifact (opt-in via
// `TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED=1`) see "[embedding-
// classifier] artifact is schema_version=1; v0.6.7 requires
// schema_version=2. Run `bun run train-embedding-classifier` to
// rebuild." in the boot logs and fall back to the heuristic + LLM-
// judge path until they retrain. Operators NOT using the embedding
// classifier (the default) are unaffected.
function extractLastUserText(body: OpenAIChatRequest): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  if (!lastUser) return "";
  // Same extraction policy as the heuristic + LLM-judge classifier.
  // First peel the multi-modal content array shape, then strip noise
  // prefixes / wrapper-in-user-message patterns so the encoded
  // features focus on the user's actual intent — not the harness's
  // boilerplate. Both helpers are idempotent on already-clean text.
  return extractUserIntent(extractTextFromContent(lastUser.content));
}

// =========================================================================
// Linear softmax head — one matrix per task_type, one for complexity
// =========================================================================

export interface ClassifierHead<C extends string> {
  /** Class labels in the order their weights are indexed. */
  classes: C[];
  /**
   * Weight matrix flattened row-major. Length = classes.length × num_buckets.
   * Row c ranges from `c * num_buckets` to `(c+1) * num_buckets`.
   *
   * Stored flat (instead of nested arrays) so the artifact JSON is
   * compact AND the inner predict loop hits sequential memory — the
   * JIT vectorizes much better that way.
   */
  weights: number[];
  /** Per-class bias term. Length = classes.length. */
  bias: number[];
  /**
   * Softmax-confidence threshold below which the caller should ignore
   * the prediction and fall back to the heuristic. Calibrated at
   * training time using a held-out validation set: we pick the
   * threshold that maximizes "agree with heuristic where heuristic is
   * confident, defer otherwise".
   */
  confidence_threshold: number;
}

/**
 * Current artifact schema version. Bumped to 2 in v0.6.7 because the
 * input-text extraction policy changed (multi-modal content arrays + harness-
 * wrapper stripping) — the encoder's hash buckets are conditioned on the
 * exact strings the trainer saw, and silently swapping extraction at
 * inference time would degrade accuracy without operator signal. The loader
 * REJECTS schema_version < 2 artifacts with a "force retrain" log so an
 * operator who upgrades the gateway without running
 * `bun run train-embedding-classifier` falls back to the heuristic path
 * cleanly instead of serving stale predictions. Bump again whenever the
 * extractor or encoder feature shape changes incompatibly.
 */
export const ARTIFACT_SCHEMA_VERSION = 2;
export type ArtifactSchemaVersion = typeof ARTIFACT_SCHEMA_VERSION;

export interface ClassifierArtifact {
  /** Schema version of THIS file format. Bump only when the on-disk
   *  shape changes incompatibly. Independent of the per-train version
   *  in `model_version`. */
  schema_version: ArtifactSchemaVersion;
  /** Per-train version string. Format: `v1.<unix_ms>` from training. */
  model_version: string;
  generated_at: string;
  /** Provenance for the dashboard / audit log. */
  trained_on: {
    rows: number;
    lookback_days: number;
    /** When training was scoped to a single project. NULL = global. */
    project_id: string | null;
    /** Counts of each label observed in the training set. */
    task_type_counts: Record<string, number>;
    complexity_counts: Record<string, number>;
  };
  encoder: EncoderConfig;
  task_type: ClassifierHead<TaskType>;
  complexity: ClassifierHead<ComplexityBucket>;
  /**
   * If we computed a held-out accuracy at training time, surface it
   * here so a dashboard can warn when it's suspiciously low.
   *
   * Per-class metrics (optional, added in v0.6.1): precision / recall /
   * support keyed by class label. `support` is the count of rows in
   * validation whose TRUE label is that class. Raw accuracy alone hides
   * class-imbalance regressions (e.g. a chat-heavy tenant's classifier
   * that gets 90% overall accuracy by always predicting "chat" — the
   * per-class recall for code / reasoning would fall off a cliff).
   *
   * When an older v0.6.0 artifact is loaded, these fields are absent;
   * all consumers must treat them as optional.
   */
  validation: {
    task_type_accuracy: number | null;
    complexity_accuracy: number | null;
    n_validation: number;
    task_type_per_class?: Record<string, PerClassMetrics>;
    complexity_per_class?: Record<string, PerClassMetrics>;
  };
}

/**
 * Standard classification metrics per class. Precision = TP / (TP+FP),
 * recall = TP / (TP+FN), support = TP + FN (count of rows whose true
 * label is this class). All in `[0, 1]` except `support` which is an
 * integer count. `precision` / `recall` are null when the denominator
 * is zero (no predictions made OR no true instances of the class).
 */
export interface PerClassMetrics {
  precision: number | null;
  recall: number | null;
  support: number;
}

/**
 * Compute softmax-normalized probabilities. Numerically stable
 * (subtract max before exp).
 */
function softmax(logits: Float32Array | number[]): Float32Array {
  const out = new Float32Array(logits.length);
  let maxL = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > maxL) maxL = logits[i];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - maxL);
    sum += out[i];
  }
  if (sum > 0) {
    const inv = 1 / sum;
    for (let i = 0; i < logits.length; i++) out[i] *= inv;
  }
  return out;
}

/**
 * Predict a single head: returns the argmax class and its softmax
 * probability (used by the caller as a confidence score).
 *
 * Hot path. Avoids array-of-array indirection and per-class object
 * allocation — single Float32Array out, one tight loop per class.
 */
export function predictHead<C extends string>(
  head: ClassifierHead<C>,
  features: Float32Array,
  num_buckets: number
): { label: C; confidence: number; probabilities: Float32Array } {
  const numClasses = head.classes.length;
  const logits = new Float32Array(numClasses);
  for (let c = 0; c < numClasses; c++) {
    let dot = head.bias[c] ?? 0;
    const offset = c * num_buckets;
    for (let i = 0; i < num_buckets; i++) {
      const f = features[i];
      // Skip-zero is a meaningful win since hashed bag-of-trigrams is
      // sparse (most buckets stay 0). Keeps the inner loop closer to
      // memory bandwidth than to ALU.
      if (f !== 0) dot += head.weights[offset + i] * f;
    }
    logits[c] = dot;
  }
  const probs = softmax(logits);
  let bestIdx = 0;
  let bestProb = probs[0];
  for (let c = 1; c < numClasses; c++) {
    if (probs[c] > bestProb) {
      bestProb = probs[c];
      bestIdx = c;
    }
  }
  return {
    label: head.classes[bestIdx],
    confidence: bestProb,
    probabilities: probs,
  };
}

// =========================================================================
// Artifact loader (memoized; absent file = no-op, fall back to heuristic)
// =========================================================================

import { readFileSync, existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let cachedArtifact: ClassifierArtifact | null = null;
let loadAttempted = false;

/**
 * Where to look for the trained artifact. Operators can point this at
 * a custom path via TOKENSMART_EMBEDDING_CLASSIFIER_PATH; default is
 * the file the training script writes next to baseline-policy.json.
 *
 * We DELIBERATELY do not ship a default artifact in source control —
 * unlike baseline-policy.json (which comes from a public policy-eval mix),
 * this classifier is trained from real customer traffic and ships
 * empty. A fresh install runs entirely on the heuristic; opt in by
 * running `bun run train-embedding-classifier` after some traffic
 * accumulates.
 */
function artifactPath(): string {
  const override = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH;
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "embedding-classifier.json");
}

/**
 * Core read-parse-validate helper. Returns the loaded artifact, or null
 * on any kind of failure (missing file, bad JSON, bad shape, IO error).
 * Logs are `tag`-prefixed so operators can tell boot-load from reload.
 *
 * Does NOT mutate `cachedArtifact` — callers are responsible for updating
 * the cache. Keeps reload paths symmetric with initial load.
 */
function readArtifactFromDisk(
  p: string,
  tag: "load" | "reload"
): ClassifierArtifact | null {
  if (!existsSync(p)) {
    if (tag === "reload") {
      console.log(`[embedding-classifier] reload requested but ${p} missing — keeping current artifact`);
    }
    return null;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as ClassifierArtifact;
    if (!isArtifactShape(parsed)) {
      // Distinguish "stale schema, just retrain" from "garbage shape" so
      // operators following the upgrade story (v0.6.6 → v0.6.7) get the
      // exact CLI to run instead of a generic shape complaint.
      const stale = describeStaleArtifactReason(parsed);
      if (stale) {
        console.warn(
          `[embedding-classifier] ${p}: ${stale} Falling back to heuristic + LLM-judge until retrained.`
        );
      } else {
        console.warn(
          `[embedding-classifier] artifact at ${p} has unexpected shape — ignoring (${tag})`
        );
      }
      return null;
    }
    console.log(
      `[embedding-classifier] ${tag}ed ${parsed.model_version} ` +
        `(rows=${parsed.trained_on.rows}, ` +
        `task_type_acc=${formatAcc(parsed.validation.task_type_accuracy)}, ` +
        `complexity_acc=${formatAcc(parsed.validation.complexity_accuracy)})`
    );
    return parsed;
  } catch (err) {
    console.warn(
      `[embedding-classifier] failed to ${tag} ${p}: ${(err as Error).message}`
    );
    return null;
  }
}

export function loadEmbeddingClassifier(): ClassifierArtifact | null {
  if (loadAttempted) return cachedArtifact;
  loadAttempted = true;

  if (process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED !== "1") {
    return null;
  }

  cachedArtifact = readArtifactFromDisk(artifactPath(), "load");
  return cachedArtifact;
}

/**
 * Hot-reload entry point. Drops the cached artifact and re-reads from
 * disk. Called by the file-mtime watcher and the pg_notify subscriber
 * when a fresh training run writes a new artifact to disk / signals a
 * new version is available.
 *
 * Contract:
 *   - Safe to call from multiple signal paths — idempotent, last write
 *     wins. A rapid burst of file events will all converge on the same
 *     final artifact.
 *   - Only loads when the env flag is set. Calling this on a gateway
 *     with the classifier disabled is a no-op that logs once (so an
 *     operator who flipped the flag OFF but left the watcher ON
 *     eventually figures out why).
 *   - Never throws. The classifier is a non-critical routing layer;
 *     a reload failure degrades to "keep the current artifact" rather
 *     than "drop routing decisions on the floor".
 *   - Returns the new artifact (or null if reload failed / flag off)
 *     so tests and health-check plumbing can assert post-reload state
 *     synchronously.
 */
export function reloadEmbeddingClassifier(): ClassifierArtifact | null {
  if (process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED !== "1") {
    if (cachedArtifact !== null) {
      console.log(
        "[embedding-classifier] reload ignored: TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED is not set to 1"
      );
    }
    cachedArtifact = null;
    loadAttempted = true;
    return null;
  }
  cachedArtifact = readArtifactFromDisk(artifactPath(), "reload");
  loadAttempted = true;
  return cachedArtifact;
}

function formatAcc(v: number | null): string {
  return v == null ? "n/a" : v.toFixed(2);
}

// ===========================================================================
// Hot-reload plumbing — fs.watch() + pg_notify
// ===========================================================================
//
// Either signal path can trigger `reloadEmbeddingClassifier()`. They're
// independent and additive:
//
//   - **File watcher**: for single-node self-host installs where the
//     training script and the gateway share a filesystem. Zero DB cost,
//     sub-second reload latency, dependency-free.
//   - **pg_notify**: for multi-replica cloud installs where the training
//     job runs on a separate pod from the gateway. Shares the existing
//     postgres.js connection infrastructure (same pattern as
//     `policy/loader.ts`).
//
// Both are OPT-IN via env. Failure to wire either one is non-fatal —
// degrades to "operator must restart the gateway to pick up a new
// artifact", which is the pre-v0.6.1 behavior.

let fileWatcher: FSWatcher | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let notifySubscribed = false;

/**
 * Debounced reload — many filesystems (esp. macOS via node fs.watch)
 * emit multiple events per single write (chmod + rename + data). We
 * coalesce into one reload to keep logs sane + skip no-op re-reads.
 */
function scheduleReload(source: "watch" | "notify"): void {
  if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
  reloadDebounceTimer = setTimeout(() => {
    reloadDebounceTimer = null;
    console.log(`[embedding-classifier] reload triggered by ${source}`);
    reloadEmbeddingClassifier();
  }, 300);
  // Timers shouldn't keep the Node event loop alive by themselves.
  // `unref()` on the handle lets the process exit cleanly on SIGTERM
  // even if a reload was pending.
  if (typeof (reloadDebounceTimer as NodeJS.Timeout).unref === "function") {
    (reloadDebounceTimer as NodeJS.Timeout).unref();
  }
}

/**
 * Start watching the artifact file for changes. Called once at boot
 * from index.ts when `TOKENSMART_EMBEDDING_CLASSIFIER_WATCH !== "0"`
 * (default ON when the classifier itself is enabled).
 *
 * Idempotent: multiple calls during dev hot-reload are no-ops. The
 * watcher's own error events are caught and logged; losing the watcher
 * falls back to "operator must restart" without crashing.
 */
export function startEmbeddingClassifierFileWatcher(): void {
  if (fileWatcher) return;
  if (process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED !== "1") return;
  if (process.env.TOKENSMART_EMBEDDING_CLASSIFIER_WATCH === "0") return;

  attachEmbeddingFileWatcher(artifactPath(), "start");
}

/**
 * Internal — open an fs.watch handle on `p` (file-direct, NOT
 * directory). Lifted from the v0.6.5 baseline-policy watcher pattern
 * for the same reason: Bun 1.3.x's `fs.watch(dir, ...)` on macOS
 * doesn't fire for in-directory writes (verified via probe; tracked
 * upstream). Directory watching was the prior strategy here, and it
 * silently broke macOS dev installs the moment v0.6.1 shipped — fixed
 * in v0.6.7 alongside the schema-2 retrain.
 *
 * Used both by the initial `startEmbeddingClassifierFileWatcher` boot
 * path AND by the reattach path that fires after a `rename` event
 * invalidates the prior subscription. Logging differentiates "start"
 * from "reattach" so operators reading the log can tell the steady-
 * state subscribe from a swap-driven re-subscribe.
 */
function attachEmbeddingFileWatcher(
  p: string,
  source: "start" | "reattach"
): void {
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
    // Best-effort retry — in practice a rename-in-place flow is
    // delete-then-create, and the create races with our re-attach.
    // Schedule a reload anyway so the next existsSync check (inside
    // readArtifactFromDisk) handles the absent-file case loudly.
    if (source === "reattach") {
      scheduleReload("watch");
    }
    return;
  }
  try {
    fileWatcher = fsWatch(p, (evt) => {
      scheduleReload("watch");
      if (evt === "rename") {
        // The current subscription is stale. Re-attach asynchronously
        // (after our debounce fires). We do it on the next event loop
        // tick so the close() doesn't race the in-flight callback.
        setImmediate(() => attachEmbeddingFileWatcher(p, "reattach"));
      }
    });
    fileWatcher.on("error", (err) => {
      console.warn(
        `[embedding-classifier] file watcher error: ${err.message} — falling back to restart-only reload`
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
        `[embedding-classifier] watching ${p} for artifact updates (disable with TOKENSMART_EMBEDDING_CLASSIFIER_WATCH=0)`
      );
    }
  } catch (err) {
    console.warn(
      `[embedding-classifier] could not ${source} file watcher on ${p}: ${(err as Error).message} — falling back to restart-only reload`
    );
    fileWatcher = null;
  }
}

/**
 * Stop the file watcher. Mostly for tests and for clean shutdown paths.
 * Also safe to call when no watcher was ever started.
 */
export function stopEmbeddingClassifierFileWatcher(): void {
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
 * Subscribe to `tokensmart_embedding_reload` Postgres notifications.
 * Emitted by the training CLI after a successful artifact write (when
 * it has DB access) OR by an operator via `SELECT
 * pg_notify('tokensmart_embedding_reload', '')`. Any payload is fine —
 * we always drop + re-read the whole artifact.
 *
 * Mirrors the `subscribeToPolicyInvalidations` pattern in
 * `policy/loader.ts` so multi-replica fan-out behaves the same across
 * these two reload channels.
 *
 * The `sql` arg is injected by the caller (normally index.ts) to avoid
 * a circular import between embedding-classifier.ts and db.ts, and to
 * let tests inject a mock connection. Returns a Promise so the boot
 * sequence can await + log failure + continue.
 */
export async function subscribeToEmbeddingClassifierReload(
  sqlClient: {
    listen: (
      channel: string,
      cb: (payload: string | null) => void
    ) => Promise<unknown>;
  }
): Promise<void> {
  if (notifySubscribed) return;
  if (process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED !== "1") return;
  notifySubscribed = true;

  try {
    await sqlClient.listen("tokensmart_embedding_reload", () => {
      scheduleReload("notify");
    });
    console.log(
      "[embedding-classifier] subscribed to tokensmart_embedding_reload (cross-replica hot-reload)"
    );
  } catch (err) {
    notifySubscribed = false;
    console.warn(
      `[embedding-classifier] LISTEN setup failed: ${(err as Error).message} — falling back to file-watch only`
    );
  }
}

/**
 * Lightweight runtime shape check. Doesn't validate every field —
 * just enough to avoid crashing on a hand-edited or older-version
 * file. The classifier code itself defends against malformed weights
 * by treating undefined values as 0 (so a partially-broken artifact
 * degrades to "predicts class 0 with low confidence" → falls back
 * to heuristic, which is what we want).
 */
function isArtifactShape(v: unknown): v is ClassifierArtifact {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  // v0.6.7 schema bump: 1 → 2. Loaders that see the older shape log a
  // helpful "force retrain" message at the call site (loadEmbeddingClassifier
  // + per-project loader) and fall back to the heuristic + LLM-judge path.
  // Refusing here is the right failure mode — a stale v1 artifact would
  // misclassify multi-modal content arrays + wrapped intents in exactly
  // the way v0.6.6 fixed for the heuristic path.
  if (a.schema_version !== ARTIFACT_SCHEMA_VERSION) return false;
  if (typeof a.model_version !== "string") return false;
  if (!a.encoder || typeof a.encoder !== "object") return false;
  if (!a.task_type || typeof a.task_type !== "object") return false;
  if (!a.complexity || typeof a.complexity !== "object") return false;
  const tt = a.task_type as Record<string, unknown>;
  const cc = a.complexity as Record<string, unknown>;
  return (
    Array.isArray(tt.classes) &&
    Array.isArray(tt.weights) &&
    Array.isArray(tt.bias) &&
    Array.isArray(cc.classes) &&
    Array.isArray(cc.weights) &&
    Array.isArray(cc.bias)
  );
}

/**
 * Inspect a candidate artifact's `schema_version` and return a short
 * diagnostic string suitable for an operator-visible log message.
 * Used by both loaders (global file + per-project DB) so they emit the
 * same wording when they reject a stale artifact. Exposed for tests.
 */
export function describeStaleArtifactReason(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const sv = (v as Record<string, unknown>).schema_version;
  if (typeof sv === "number" && sv < ARTIFACT_SCHEMA_VERSION) {
    return (
      `artifact is schema_version=${sv}; v0.6.7 requires schema_version=` +
      `${ARTIFACT_SCHEMA_VERSION}. Run \`bun run train-embedding-classifier\` ` +
      `(or \`--all-enabled\` to rebuild every per-project artifact) to refresh.`
    );
  }
  return null;
}

/**
 * Test-only reset hook so unit tests don't bleed loader state across
 * cases. Same pattern as semantic-cache.
 *
 * Resets BOTH the cached artifact state and the pg_notify subscription
 * bookkeeping so a test that simulates subscribe-failure doesn't get
 * short-circuited by a previous test's successful subscribe.
 */
export function _resetEmbeddingClassifier(): void {
  cachedArtifact = null;
  loadAttempted = false;
  notifySubscribed = false;
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = null;
  }
  stopEmbeddingClassifierFileWatcher();
}

/**
 * Test-only injection hook. Lets a unit test plug a hand-crafted
 * artifact into the classifier without going through the env-flag +
 * fs-read dance, so we can pin behavior with predictable weights.
 */
export function _setEmbeddingClassifierForTest(a: ClassifierArtifact | null): void {
  cachedArtifact = a;
  loadAttempted = true;
}

// =========================================================================
// Public predict surface — used by task-classifier.ts
// =========================================================================

export interface EmbeddingPrediction {
  task_type: TaskType;
  task_type_confidence: number;
  complexity: ComplexityBucket;
  complexity_confidence: number;
  /** Mirror of the heuristic's [0,1] complexity_score, derived from
   *  the complexity head's softmax:
   *  simple→0.1, medium→0.45, hard→0.72, frontier→0.95
   *  weighted by class probability. Lets downstream code (router
   *  metrics, dashboard sparklines) keep using a continuous score
   *  without reimplementing thresholding. */
  complexity_score: number;
  /** Was the classifier confident enough that the caller should TRUST
   *  this prediction, or should they fall back to the heuristic? */
  confident: boolean;
  /** Machine-readable reason for routing logs. */
  reason: string;
}

/**
 * Bucket → continuous score mapping. Picked to match what the
 * heuristic's `bucketFromScore()` would invert into:
 *
 *   simple  ↔ 0.1   (well below 0.25)
 *   medium  ↔ 0.45  (mid-bucket)
 *   hard    ↔ 0.72  (mid hard bucket)
 *   frontier↔ 0.95  (flagship / agentic upper bucket)
 *
 * The expected score is then E[X | probs] = Σ P(c) * SCORE[c]. This
 * is a sane ordinal aggregation — a request that's 50/50 medium/hard
 * lands at 0.65, between the bucket centroids, which downstream
 * consumers (cost-anomaly monitor, dashboard "complexity over time"
 * sparkline) interpret correctly.
 */
const COMPLEXITY_SCORE: Record<ComplexityBucket, number> = {
  simple: 0.1,
  medium: 0.45,
  hard: 0.72,
  frontier: 0.95,
};

function expectedComplexityScore(
  classes: ComplexityBucket[],
  probs: Float32Array
): number {
  let s = 0;
  for (let i = 0; i < classes.length; i++) {
    s += COMPLEXITY_SCORE[classes[i]] * probs[i];
  }
  return Math.max(0, Math.min(1, s));
}

/**
 * Run the embedding classifier on a request. Returns NULL when no
 * artifact is loaded (caller falls back to the heuristic). Returns
 * a prediction with `confident: false` when the artifact loaded but
 * neither head crossed its softmax-confidence threshold (caller
 * STILL falls back, but we surface the embedding's best guess for
 * observability).
 */
export function classifyWithEmbedding(
  body: OpenAIChatRequest,
  artifact: ClassifierArtifact | null = loadEmbeddingClassifier()
): EmbeddingPrediction | null {
  if (!artifact) return null;
  const features = encodeRequest(body, artifact.encoder);
  const ttPred = predictHead<TaskType>(
    artifact.task_type,
    features,
    artifact.encoder.num_buckets
  );
  const cxPred = predictHead<ComplexityBucket>(
    artifact.complexity,
    features,
    artifact.encoder.num_buckets
  );
  const ttConfident = ttPred.confidence >= artifact.task_type.confidence_threshold;
  const cxConfident = cxPred.confidence >= artifact.complexity.confidence_threshold;
  // We require BOTH heads to be confident before trusting the
  // embedding entirely. Half-trust (one head from embedding, one
  // from heuristic) is harder to reason about for routing logs and
  // doesn't actually improve accuracy in the experiments — easier
  // to defer to heuristic and revisit when one head has a much
  // weaker signal than the other.
  const confident = ttConfident && cxConfident;
  return {
    task_type: ttPred.label,
    task_type_confidence: ttPred.confidence,
    complexity: cxPred.label,
    complexity_confidence: cxPred.confidence,
    complexity_score: expectedComplexityScore(
      artifact.complexity.classes,
      cxPred.probabilities
    ),
    confident,
    reason: `embedding:tt=${ttPred.label}(${ttPred.confidence.toFixed(2)}):cx=${cxPred.label}(${cxPred.confidence.toFixed(2)})`,
  };
}

/**
 * Test-only handles. Same convention as semantic-cache.
 */
export const _testInternals = {
  fnv1a32,
  softmax,
  COMPLEXITY_SCORE,
  expectedComplexityScore,
  artifactPath,
};
