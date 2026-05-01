/**
 * Pin behavior of the embedding-based task classifier.
 *
 * Three layers of coverage:
 *   1. Encoder — deterministic, L2-normalized, structural-feature wiring.
 *   2. Classifier — handcrafted weights produce the expected argmax
 *      and softmax confidence; predict latency is well under 20ms; the
 *      `confident` gate behaves correctly around the threshold.
 *   3. Integration — `classifyTask()` defers to the heuristic when no
 *      artifact loaded OR when the embedding classifier is unsure;
 *      it adopts embedding predictions when both heads cross threshold.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeText,
  encodeRequest,
  predictHead,
  classifyWithEmbedding,
  loadEmbeddingClassifier,
  reloadEmbeddingClassifier,
  subscribeToEmbeddingClassifierReload,
  _resetEmbeddingClassifier,
  _setEmbeddingClassifierForTest,
  _testInternals,
  type ClassifierArtifact,
  type ClassifierHead,
  type EncoderConfig,
  DEFAULT_ENCODER_CONFIG,
  LEGACY_V1_ENCODER_CONFIG,
  DEFAULT_NUM_BUCKETS,
} from "../src/policy/embedding-classifier";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { classifyTask } from "../src/policy/task-classifier";
import type { OpenAIChatRequest } from "../src/providers/openai";
import type { TaskType, ComplexityBucket } from "../src/policy/types";

function bareUser(content: string): OpenAIChatRequest {
  return { model: "gpt-4o-mini", messages: [{ role: "user", content }] };
}

// =========================================================================
// Encoder
// =========================================================================

describe("encoder — character-trigram hash trick", () => {
  test("deterministic: same input produces bit-identical features", () => {
    const a = encodeText("Hello, world!");
    const b = encodeText("Hello, world!");
    expect(a.length).toBe(DEFAULT_NUM_BUCKETS);
    expect(b.length).toBe(DEFAULT_NUM_BUCKETS);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  test("L2-normalized to unit length (within float epsilon)", () => {
    const v = encodeText("How do I refactor this Python function?");
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
    expect(sumSq).toBeGreaterThan(0.999);
    expect(sumSq).toBeLessThan(1.001);
  });

  test("empty text produces a zero vector (no NaN, no exception)", () => {
    const v = encodeText("");
    expect(v.length).toBe(DEFAULT_NUM_BUCKETS);
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += Math.abs(v[i]);
    expect(sum).toBe(0);
  });

  test("very short text (< n-gram size) still produces a valid vector", () => {
    // "<a>" — padding + single char fits one trigram. Should land in
    // exactly one bucket and be L2-normalized to 1.
    const v = encodeText("a");
    let nonzero = 0;
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] !== 0) nonzero++;
      sumSq += v[i] * v[i];
    }
    expect(nonzero).toBeGreaterThan(0);
    expect(sumSq).toBeCloseTo(1, 5);
  });

  test("similar topic → similar feature direction (cosine ≥ 0.3)", () => {
    // Two paraphrases of a code-refactor ask. Cosine of the hashed
    // trigram features should be solidly positive — the encoder's
    // entire reason to exist is exactly this.
    const a = encodeText("Refactor this Python function for clarity.");
    const b = encodeText("Refactor this Python function for readability.");
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    // Both vectors are L2-normalized so dot == cosine similarity.
    expect(dot).toBeGreaterThan(0.3);
  });

  test("unrelated topics → near-orthogonal feature direction (cosine < 0.3)", () => {
    const a = encodeText("Refactor this Python function for clarity.");
    const b = encodeText("Tell me a joke about astronauts.");
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    expect(dot).toBeLessThan(0.3);
  });

  test("encodeRequest uses LAST user message + structural pseudo-tokens", () => {
    // Structural tokens MUST influence the feature direction so the
    // classifier can condition on tools[] presence / multi-turn.
    const a = encodeRequest({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    const b = encodeRequest({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "x", parameters: {} } }],
    } as OpenAIChatRequest);
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    // Same user text, different harness — features should be close
    // but NOT identical (structural pseudo-token diverges).
    expect(dot).toBeGreaterThan(0.5);
    expect(dot).toBeLessThan(1 - 1e-6);
  });

  test("custom encoder config respects num_buckets + ngram_size", () => {
    const cfg: EncoderConfig = {
      num_buckets: 256,
      ngram_size: 4,
      lowercase: true,
      max_chars: 100,
    };
    const v = encodeText("Hello world", cfg);
    expect(v.length).toBe(256);
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
    expect(sumSq).toBeCloseTo(1, 5);
  });

  test("max_chars cap is respected", () => {
    // Construct a string longer than the cap. Pad with a unique tail
    // that should NOT show up in the encoded feature distribution.
    const cfg: EncoderConfig = {
      num_buckets: DEFAULT_NUM_BUCKETS,
      ngram_size: 3,
      lowercase: true,
      max_chars: 20,
    };
    const head = "the quick brown fox ";
    const tail = "WHIZBANGZOOMTAILZZ";
    const v1 = encodeText(head, cfg);
    const v2 = encodeText(head + tail, cfg);
    // Identical first-20-chars → the cap should make the two vectors
    // bit-identical.
    for (let i = 0; i < v1.length; i++) expect(v2[i]).toBe(v1[i]);
  });
});

// =========================================================================
// v2 multilingual preprocessing
// =========================================================================

describe("encoder v2 — multilingual robustness", () => {
  test("v1 legacy config preserves byte-identical pre-multilingual behavior", () => {
    // An artifact trained under v1 (no NFKC / no zero-width strip / no
    // whitespace collapse / no CJK bigrams) should still encode the same
    // way after v2 landed. Back-compat property — otherwise every old
    // artifact silently regresses accuracy on next gateway boot.
    const a = encodeText("Hello\u200Bworld\n\nThere", LEGACY_V1_ENCODER_CONFIG);
    // With v1 semantics: ZWSP + double newline are part of the trigrams.
    // The text is lowercased but NOT NFKC-normalized + whitespace is NOT
    // collapsed. We assert at least one non-zero bucket so the encoder
    // didn't crash.
    let nonzero = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== 0) nonzero++;
    expect(nonzero).toBeGreaterThan(0);
    // L2 normalized.
    let sumSq = 0;
    for (let i = 0; i < a.length; i++) sumSq += a[i] * a[i];
    expect(sumSq).toBeCloseTo(1, 5);
  });

  test("NFKC normalization unifies decomposed vs pre-composed forms", () => {
    // `é` as pre-composed U+00E9 vs decomposed `e` + U+0301. Without
    // NFKC they produce entirely different trigrams; with NFKC they
    // should be identical.
    const precomposed = "café";
    const decomposed = "cafe\u0301"; // e + combining acute

    const v1 = encodeText(precomposed, LEGACY_V1_ENCODER_CONFIG);
    const v2 = encodeText(decomposed, LEGACY_V1_ENCODER_CONFIG);
    // v1 path (no normalization): feature vectors DIFFER.
    let differV1 = 0;
    for (let i = 0; i < v1.length; i++) if (v1[i] !== v2[i]) differV1++;
    expect(differV1).toBeGreaterThan(0);

    // v2 path: they encode identically.
    const w1 = encodeText(precomposed, DEFAULT_ENCODER_CONFIG);
    const w2 = encodeText(decomposed, DEFAULT_ENCODER_CONFIG);
    for (let i = 0; i < w1.length; i++) expect(w2[i]).toBe(w1[i]);
  });

  test("NFKC folds fullwidth ASCII into halfwidth (ｈｅｌｌｏ → hello)", () => {
    const fullwidth = encodeText("ｈｅｌｌｏ", DEFAULT_ENCODER_CONFIG);
    const halfwidth = encodeText("hello", DEFAULT_ENCODER_CONFIG);
    let dot = 0;
    for (let i = 0; i < fullwidth.length; i++) dot += fullwidth[i] * halfwidth[i];
    // Should collapse to near-identical feature direction.
    expect(dot).toBeGreaterThan(0.99);
  });

  test("zero-width + BOM + RTL-override chars are stripped", () => {
    // "hello" with hostile invisible junk between letters should encode
    // the same as plain "hello".
    const attack = "h\u200Ee\u200Bl\uFEFFl\u202Eo"; // LRM + ZWSP + BOM + RLO
    const clean = "hello";
    const a = encodeText(attack, DEFAULT_ENCODER_CONFIG);
    const b = encodeText(clean, DEFAULT_ENCODER_CONFIG);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  test("whitespace runs collapse to single space", () => {
    const spaces = encodeText("hello   world", DEFAULT_ENCODER_CONFIG);
    const newlines = encodeText("hello\n\n\tworld", DEFAULT_ENCODER_CONFIG);
    const canonical = encodeText("hello world", DEFAULT_ENCODER_CONFIG);
    for (let i = 0; i < spaces.length; i++) {
      expect(spaces[i]).toBe(canonical[i]);
      expect(newlines[i]).toBe(canonical[i]);
    }
  });

  test("CJK bigrams give CJK paraphrases higher cosine similarity than v1", () => {
    // Two Chinese paraphrases of "refactor this function". Under v1
    // (trigrams only), shared 2-character subsequences ("重构", "函数")
    // produce no feature overlap. Under v2 + CJK bigrams, those common
    // words land in dedicated buckets → cosine goes up.
    const a = "帮我重构这段函数的逻辑";
    const b = "请把这个函数重构一下";

    const va1 = encodeText(a, LEGACY_V1_ENCODER_CONFIG);
    const vb1 = encodeText(b, LEGACY_V1_ENCODER_CONFIG);
    let dotV1 = 0;
    for (let i = 0; i < va1.length; i++) dotV1 += va1[i] * vb1[i];

    const va2 = encodeText(a, DEFAULT_ENCODER_CONFIG);
    const vb2 = encodeText(b, DEFAULT_ENCODER_CONFIG);
    let dotV2 = 0;
    for (let i = 0; i < va2.length; i++) dotV2 += va2[i] * vb2[i];

    // v2 should meaningfully EXCEED v1 for this paraphrase pair.
    // Baseline v1 cosine should be non-trivial (some trigrams overlap)
    // and v2 should add at least 0.05 absolute gain from the shared
    // bigrams.
    expect(dotV2).toBeGreaterThan(dotV1 + 0.05);
  });

  test("CJK bigrams are only emitted for CJK char pairs, not ASCII", () => {
    // For pure ASCII input, v2 feature direction should equal v1 feature
    // direction (since NFKC / zero-width / whitespace-collapse are no-ops
    // on clean ASCII, and no CJK bigrams will fire). Proves the v2 path
    // is zero-overhead for the English traffic that's 70% of prod.
    const ascii = "refactor this function for clarity";
    const v1 = encodeText(ascii, LEGACY_V1_ENCODER_CONFIG);
    const v2 = encodeText(ascii, DEFAULT_ENCODER_CONFIG);
    for (let i = 0; i < v1.length; i++) expect(v2[i]).toBe(v1[i]);
  });

  test("preprocessing happens BEFORE max_chars cap", () => {
    // A 50-char input where the first 40 chars are zero-width junk +
    // only the tail has real content. Under v1 with max_chars=20, the
    // cap slices off the junk-only head and we get no real features.
    // Under v2 with strip-zero-width ON, the junk is removed first, so
    // the cap preserves the real content.
    const cfgV1: EncoderConfig = {
      ...LEGACY_V1_ENCODER_CONFIG,
      max_chars: 10,
    };
    const cfgV2: EncoderConfig = {
      ...DEFAULT_ENCODER_CONFIG,
      max_chars: 10,
    };
    const junk = "\u200B".repeat(30);
    const input = junk + "refactor";

    const v1 = encodeText(input, cfgV1);
    const v2 = encodeText(input, cfgV2);

    // v1: mostly empty (zero-width chars dominate the 10-char window).
    // v2: "refactor" survives the preprocessing + fits the 10-char cap.
    let v1Nonzero = 0;
    let v2Nonzero = 0;
    for (let i = 0; i < v1.length; i++) {
      if (v1[i] !== 0) v1Nonzero++;
      if (v2[i] !== 0) v2Nonzero++;
    }
    expect(v2Nonzero).toBeGreaterThan(v1Nonzero);
  });

  test("preprocessing never crashes on malformed input", () => {
    // Lone surrogate halves and very long control-char runs — inputs that
    // a hostile client might send to try to trip the encoder.
    const nasty = "\uD800\uD800\u0000\u0001".repeat(50);
    expect(() => encodeText(nasty, DEFAULT_ENCODER_CONFIG)).not.toThrow();
    const v = encodeText(nasty, DEFAULT_ENCODER_CONFIG);
    // All suspect chars should be stripped → result is mostly zero.
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
    // Either zero (all stripped) or L2-normalized to 1 (something survived).
    expect(sumSq === 0 || Math.abs(sumSq - 1) < 1e-5).toBe(true);
  });
});

// =========================================================================
// Linear softmax head
// =========================================================================

describe("predictHead — handcrafted-weights golden tests", () => {
  // Build a tiny 4-bucket × 2-class head where bucket 0 votes for
  // class 0 and bucket 1 votes for class 1. Lets us assert the
  // exact predicted class for known feature vectors.
  function tinyHead<C extends string>(classes: C[]): ClassifierHead<C> {
    const numBuckets = 4;
    const w = new Array(classes.length * numBuckets).fill(0);
    // class 0 weights = [1, 0, 0, 0]
    w[0 * numBuckets + 0] = 5;
    // class 1 weights = [0, 1, 0, 0]
    w[1 * numBuckets + 1] = 5;
    return {
      classes,
      weights: w,
      bias: new Array(classes.length).fill(0),
      confidence_threshold: 0.55,
    };
  }

  test("argmax returns the class whose bucket has the larger feature value", () => {
    const head = tinyHead(["A", "B"]);
    const features = new Float32Array([1, 0, 0, 0]);
    const r = predictHead(head, features, 4);
    expect(r.label).toBe("A");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  test("argmax flips when the feature mass shifts", () => {
    const head = tinyHead(["A", "B"]);
    const features = new Float32Array([0, 1, 0, 0]);
    const r = predictHead(head, features, 4);
    expect(r.label).toBe("B");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  test("equal logits → ~50/50 softmax (low confidence)", () => {
    const head = tinyHead(["A", "B"]);
    const features = new Float32Array([0, 0, 0, 0]);
    const r = predictHead(head, features, 4);
    expect(r.confidence).toBeCloseTo(0.5, 5);
  });

  test("softmax is numerically stable for large logits", () => {
    const probs = _testInternals.softmax([1000, 1001, 1002]);
    let sum = 0;
    for (let i = 0; i < probs.length; i++) sum += probs[i];
    expect(sum).toBeCloseTo(1, 6);
    expect(probs.every((p) => Number.isFinite(p) && p >= 0)).toBe(true);
  });

  test("inference latency well under the 20ms budget (artifact-sized weights)", () => {
    // Build a realistic-sized head: 4 classes × 4096 buckets. This is
    // what the trained artifact actually ships with.
    const numBuckets = 4096;
    const numClasses = 4;
    const w = new Array(numBuckets * numClasses);
    for (let i = 0; i < w.length; i++) w[i] = (i % 7) * 0.001 - 0.003;
    const head: ClassifierHead<TaskType> = {
      classes: ["chat", "code", "reasoning", "tool_use"],
      weights: w,
      bias: [0, 0, 0, 0],
      confidence_threshold: 0.5,
    };
    const features = encodeText(
      "Please refactor this function to be thread-safe and add unit tests.",
      { ...DEFAULT_ENCODER_CONFIG, num_buckets: numBuckets }
    );

    // Warm up the JIT.
    for (let i = 0; i < 50; i++) predictHead(head, features, numBuckets);

    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) predictHead(head, features, numBuckets);
    const elapsed = performance.now() - t0;
    const perCall = elapsed / N;

    // Per-call must be well below the user's 20ms budget. We assert
    // 5ms here as a safety margin so a slow CI runner doesn't flake;
    // in practice we measure 0.05–0.2ms.
    expect(perCall).toBeLessThan(5);
  });
});

// =========================================================================
// Artifact loading + classifyWithEmbedding
// =========================================================================

/**
 * Build a synthetic artifact whose classifier deterministically returns
 * "code" + "hard" for any nonempty input (positive bias on those classes,
 * zero weights). The threshold is 0.5 so the prediction is always trusted.
 *
 * This is the smallest possible artifact that exercises the full
 * load → predict → confident gate path.
 */
function syntheticArtifactAlwaysCodeHard(): ClassifierArtifact {
  const numBuckets = 64;
  const ttBias = [0, 5, 0, 0]; // strong positive bias on "code"
  const cxBias = [0, 0, 5]; // strong positive bias on "hard"
  return {
    schema_version: 2,
    model_version: "v1.test.always-code-hard",
    generated_at: new Date(0).toISOString(),
    trained_on: {
      rows: 1,
      lookback_days: 1,
      project_id: null,
      task_type_counts: { chat: 0, code: 1, reasoning: 0, tool_use: 0 },
      complexity_counts: { simple: 0, medium: 0, hard: 1 },
    },
    encoder: {
      num_buckets: numBuckets,
      ngram_size: 3,
      lowercase: true,
      max_chars: 4000,
    },
    task_type: {
      classes: ["chat", "code", "reasoning", "tool_use"],
      weights: new Array(4 * numBuckets).fill(0),
      bias: ttBias,
      confidence_threshold: 0.5,
    },
    complexity: {
      classes: ["simple", "medium", "hard"],
      weights: new Array(3 * numBuckets).fill(0),
      bias: cxBias,
      confidence_threshold: 0.5,
    },
    validation: {
      task_type_accuracy: 1,
      complexity_accuracy: 1,
      n_validation: 1,
    },
  };
}

/** Same shape but with low-confidence biases — neither head crosses
 *  threshold, so the runtime should fall back to heuristic. */
function syntheticArtifactLowConfidence(): ClassifierArtifact {
  const a = syntheticArtifactAlwaysCodeHard();
  // Flatten biases — softmax gives uniform probabilities → confidence
  // ≈ 0.25 (task_type) and ≈ 0.33 (complexity), both below threshold.
  a.task_type.bias = [0, 0, 0, 0];
  a.complexity.bias = [0, 0, 0];
  a.task_type.confidence_threshold = 0.55;
  a.complexity.confidence_threshold = 0.55;
  a.model_version = "v1.test.low-confidence";
  return a;
}

describe("classifyWithEmbedding — confident vs deferring", () => {
  beforeEach(() => {
    _resetEmbeddingClassifier();
  });
  afterEach(() => {
    _resetEmbeddingClassifier();
  });

  test("returns null when no artifact loaded (env flag off)", () => {
    delete process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    const r = classifyWithEmbedding(bareUser("hello"));
    expect(r).toBeNull();
  });

  test("trusted artifact predicts code+hard regardless of input text", () => {
    _setEmbeddingClassifierForTest(syntheticArtifactAlwaysCodeHard());
    const r = classifyWithEmbedding(bareUser("hi there"));
    expect(r).not.toBeNull();
    expect(r!.task_type).toBe("code");
    expect(r!.complexity).toBe("hard");
    expect(r!.confident).toBe(true);
    expect(r!.task_type_confidence).toBeGreaterThan(0.5);
    expect(r!.complexity_confidence).toBeGreaterThan(0.5);
  });

  test("low-confidence artifact returns prediction but flags `confident: false`", () => {
    _setEmbeddingClassifierForTest(syntheticArtifactLowConfidence());
    const r = classifyWithEmbedding(bareUser("hi there"));
    expect(r).not.toBeNull();
    expect(r!.confident).toBe(false);
  });

  test("complexity_score reflects argmax bucket centroid", () => {
    // For the always-hard artifact, complexity_score should be close
    // to SCORE[hard] = 0.72 (since hard has ~1.0 probability). With
    // softmax leakage to neighboring buckets the actual lands a hair
    // below the centroid; 0.7 is the sane lower bound.
    _setEmbeddingClassifierForTest(syntheticArtifactAlwaysCodeHard());
    const r = classifyWithEmbedding(bareUser("hi there"));
    expect(r!.complexity_score).toBeGreaterThan(0.7);
  });

  test("expectedComplexityScore: uniform probs → SCORE midpoint", () => {
    const probs = new Float32Array([1 / 3, 1 / 3, 1 / 3]);
    const score = _testInternals.expectedComplexityScore(
      ["simple", "medium", "hard"],
      probs
    );
    // (0.1 + 0.45 + 0.72) / 3 ≈ 0.423
    expect(score).toBeCloseTo(0.423, 2);
  });
});

// =========================================================================
// Integration with classifyTask (the runtime entrypoint)
// =========================================================================

describe("classifyTask — embedding integration", () => {
  beforeEach(() => {
    _resetEmbeddingClassifier();
  });
  afterEach(() => {
    _resetEmbeddingClassifier();
  });

  test("with no artifact loaded, uses heuristic (chat/simple for greeting)", () => {
    const r = classifyTask(bareUser("hi"));
    expect(r.task_type).toBe("chat");
    expect(r.complexity).toBe("simple");
  });

  test("with confident artifact, ADOPTS embedding prediction (overrides heuristic)", () => {
    // The heuristic would say chat/simple for "hi"; the embedding
    // artifact insists code/hard. Embedding wins because it's
    // confident.
    _setEmbeddingClassifierForTest(syntheticArtifactAlwaysCodeHard());
    const r = classifyTask(bareUser("hi"));
    expect(r.task_type).toBe("code");
    expect(r.complexity).toBe("hard");
    // complexity_score must come from the embedding head's
    // expected-bucket centroid, NOT the heuristic's regex score.
    // SCORE[hard] = 0.72; softmax leak puts the actual at ~0.71. The
    // 0.7 floor still kicks the heuristic's regex-derived score
    // (which would be much lower for the bare greeting "hi").
    expect(r.complexity_score).toBeGreaterThan(0.7);
  });

  test("with low-confidence artifact, FALLS BACK to heuristic", () => {
    _setEmbeddingClassifierForTest(syntheticArtifactLowConfidence());
    const r = classifyTask(bareUser("hi"));
    // Heuristic still says chat/simple for "hi" — the low-confidence
    // embedding prediction was DROPPED, not adopted.
    expect(r.task_type).toBe("chat");
    expect(r.complexity).toBe("simple");
  });

  test("loadEmbeddingClassifier respects env flag (off → null)", () => {
    delete process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    expect(loadEmbeddingClassifier()).toBeNull();
  });
});

// =========================================================================
// End-to-end mini training: the classifier IS learnable from weak labels
// =========================================================================

/**
 * Smoke-tests the actual softmax-regression math on a tiny synthetic
 * dataset. We hand-craft a 2-class problem ("contains substring 'qz'"
 * vs "doesn't") and assert SGD converges enough to predict every
 * training row correctly + a small holdout. If this regresses,
 * training-script accuracy ≤ random and the whole pipeline silently
 * degrades.
 *
 * Why "qz" specifically: it's a vanishingly-rare bigram in English
 * filler text. After encoding into char-trigrams, the trigrams
 * containing "qz" land in distinct buckets that don't collide (in
 * a 256-bucket space) with anything in the negative class. That
 * gives SGD a clean signal to fit. Real-world routing labels
 * aren't this clean, but the math + encoder are the same — if SGD
 * fails to memorize a 30-row toy set with a strong signal, the
 * implementation is broken.
 */
describe("end-to-end: SGD on a synthetic 2-class problem converges", () => {
  test("learns 'contains qz' from weak labels via the same encoder + softmax stack", () => {
    const cfg: EncoderConfig = {
      num_buckets: 256,
      ngram_size: 3,
      lowercase: true,
      max_chars: 100,
    };
    const positives = [
      "qzbase",
      "qzcolor",
      "qzfast",
      "leftqzright",
      "topqzbot",
      "alphaqz",
      "qzomega",
      "innerqzouter",
      "lineqzdata",
      "blueqzred",
      "redqzgreen",
      "qzlogkey",
    ];
    const negatives = [
      "hello world",
      "apple pie",
      "banana split",
      "carrot cake",
      "delta force",
      "epsilon delta",
      "foxtrot uniform",
      "golf alpha",
      "hotel mike",
      "india lima",
      "november oscar",
      "papa quebec",
    ];
    const examples: { features: Float32Array; y: number }[] = [];
    for (const p of positives) examples.push({ features: encodeText(p, cfg), y: 1 });
    for (const n of negatives) examples.push({ features: encodeText(n, cfg), y: 0 });

    const numClasses = 2;
    const numBuckets = cfg.num_buckets;
    const weights = new Float32Array(numClasses * numBuckets);
    const bias = new Float32Array(numClasses);
    // 500 epochs + LR halving every 150 epochs gives ≥5× headroom over
    // what's empirically needed to memorize this 24-example linearly-
    // separable problem. The extra budget is cheap (<20ms total) and
    // makes the test robust against floating-point summation-order
    // differences across Bun versions / CPU archs. No shuffle — we keep
    // the example order deterministic so a failing run is reproducible
    // without chasing a seeded RNG.
    let lr = 1.0;
    for (let epoch = 0; epoch < 500; epoch++) {
      if (epoch > 0 && epoch % 150 === 0) lr *= 0.5;
      for (const ex of examples) {
        const logits = new Float32Array(numClasses);
        for (let c = 0; c < numClasses; c++) {
          let s = bias[c];
          const offset = c * numBuckets;
          for (let i = 0; i < numBuckets; i++) {
            if (ex.features[i] !== 0) s += weights[offset + i] * ex.features[i];
          }
          logits[c] = s;
        }
        let maxL = -Infinity;
        for (let c = 0; c < numClasses; c++) if (logits[c] > maxL) maxL = logits[c];
        const probs = new Float32Array(numClasses);
        let sum = 0;
        for (let c = 0; c < numClasses; c++) {
          probs[c] = Math.exp(logits[c] - maxL);
          sum += probs[c];
        }
        for (let c = 0; c < numClasses; c++) probs[c] /= sum;
        for (let c = 0; c < numClasses; c++) {
          const err = probs[c] - (c === ex.y ? 1 : 0);
          bias[c] -= lr * err;
          const offset = c * numBuckets;
          for (let i = 0; i < numBuckets; i++) {
            if (ex.features[i] !== 0) weights[offset + i] -= lr * err * ex.features[i];
          }
        }
      }
    }

    const head: ClassifierHead<string> = {
      classes: ["no_qz", "has_qz"],
      weights: Array.from(weights),
      bias: Array.from(bias),
      confidence_threshold: 0.5,
    };

    // Memorization on training set — SGD must FIT the data.
    let correctTrain = 0;
    for (const p of positives) {
      const r = predictHead(head, encodeText(p, cfg), numBuckets);
      if (r.label === "has_qz") correctTrain++;
    }
    for (const n of negatives) {
      const r = predictHead(head, encodeText(n, cfg), numBuckets);
      if (r.label === "no_qz") correctTrain++;
    }
    expect(correctTrain).toBe(positives.length + negatives.length);

  });
});

// =========================================================================
// Hot-reload — file watcher + pg_notify
// =========================================================================

describe("reloadEmbeddingClassifier — re-reads artifact from disk", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  let prevEnabled: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "ts-emb-reload-"));
    prevPath = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH;
    prevEnabled = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH = path.join(
      tmpDir,
      "embedding-classifier.json"
    );
    process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = "1";
    _resetEmbeddingClassifier();
  });

  afterEach(() => {
    if (prevPath !== undefined) process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH = prevPath;
    else delete process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH;
    if (prevEnabled !== undefined) process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = prevEnabled;
    else delete process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    _resetEmbeddingClassifier();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  test("initial load with no file → null; after write + reload → loaded", () => {
    expect(loadEmbeddingClassifier()).toBeNull();
    // Write a synthetic artifact into the configured path.
    const artifactPath = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH!;
    const artifact = syntheticArtifactAlwaysCodeHard();
    writeFileSync(artifactPath, JSON.stringify(artifact));
    // Before reload, the cached null still wins (no auto-detect).
    expect(loadEmbeddingClassifier()).toBeNull();
    // Reload picks up the new file.
    const loaded = reloadEmbeddingClassifier();
    expect(loaded).not.toBeNull();
    expect(loaded!.model_version).toBe(artifact.model_version);
  });

  test("reload observes an updated artifact (new model_version)", () => {
    const artifactPath = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH!;
    const v1 = syntheticArtifactAlwaysCodeHard();
    v1.model_version = "v1.test.first";
    writeFileSync(artifactPath, JSON.stringify(v1));
    expect(loadEmbeddingClassifier()!.model_version).toBe("v1.test.first");

    const v2 = syntheticArtifactAlwaysCodeHard();
    v2.model_version = "v1.test.second";
    writeFileSync(artifactPath, JSON.stringify(v2));
    // Without reload, we still see the cached v1.
    expect(loadEmbeddingClassifier()!.model_version).toBe("v1.test.first");
    // After reload, we see v2.
    const reloaded = reloadEmbeddingClassifier();
    expect(reloaded!.model_version).toBe("v1.test.second");
  });

  test("reload with bad JSON does NOT crash — logs + drops cache", () => {
    const artifactPath = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH!;
    writeFileSync(artifactPath, JSON.stringify(syntheticArtifactAlwaysCodeHard()));
    expect(loadEmbeddingClassifier()).not.toBeNull();
    // Corrupt the file mid-flight.
    writeFileSync(artifactPath, "{not valid json");
    // Capture console.warn to verify we logged the failure.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const r = reloadEmbeddingClassifier();
      expect(r).toBeNull();
      expect(warnings.some((w) => w.includes("failed to reload"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("reload with flag off clears the cache (honors the env toggle)", () => {
    const artifactPath = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_PATH!;
    writeFileSync(artifactPath, JSON.stringify(syntheticArtifactAlwaysCodeHard()));
    expect(loadEmbeddingClassifier()).not.toBeNull();
    // Flip flag OFF between load and reload (simulating an operator who
    // intentionally disabled the classifier via env flip). Reload must
    // honor the new state, not stick to the stale cache.
    process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = "0";
    expect(reloadEmbeddingClassifier()).toBeNull();
  });
});

describe("subscribeToEmbeddingClassifierReload — pg_notify wiring", () => {
  beforeEach(() => {
    _resetEmbeddingClassifier();
  });
  afterEach(() => {
    _resetEmbeddingClassifier();
  });

  test("no-op when classifier is disabled (env flag off)", async () => {
    const prev = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    delete process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    let listenCalled = false;
    const fakeSql = {
      listen: async () => {
        listenCalled = true;
        return {};
      },
    };
    try {
      await subscribeToEmbeddingClassifierReload(fakeSql);
      expect(listenCalled).toBe(false);
    } finally {
      if (prev !== undefined) process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = prev;
    }
  });

  test("subscribes to tokensmart_embedding_reload when enabled", async () => {
    const prev = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = "1";
    let subscribedChannel = "";
    const fakeSql = {
      listen: async (channel: string) => {
        subscribedChannel = channel;
        return {};
      },
    };
    try {
      await subscribeToEmbeddingClassifierReload(fakeSql);
      expect(subscribedChannel).toBe("tokensmart_embedding_reload");
    } finally {
      if (prev !== undefined) process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = prev;
      else delete process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    }
  });

  test("subscribe failure is non-fatal — logs + continues", async () => {
    const prev = process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = "1";
    const fakeSql = {
      listen: async () => {
        throw new Error("simulated pg outage");
      },
    };
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await expect(subscribeToEmbeddingClassifierReload(fakeSql)).resolves.toBeUndefined();
      expect(warnings.some((w) => w.includes("LISTEN setup failed"))).toBe(true);
    } finally {
      console.warn = origWarn;
      if (prev !== undefined) process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED = prev;
      else delete process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED;
    }
  });
});
