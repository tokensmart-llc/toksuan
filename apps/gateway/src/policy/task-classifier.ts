import type { OpenAIChatRequest } from "../providers/openai";
import type { TaskType, ComplexityBucket } from "./types";
import { complexityScore } from "../classifier";
import {
  classifyWithEmbedding,
  type ClassifierArtifact,
} from "./embedding-classifier";
import { loadActiveEmbeddingClassifier } from "./embedding-classifier-loader";

/**
 * Classify an incoming request into (task_type, complexity_bucket) for
 * baseline-policy lookup.
 *
 * Four layers in increasing cost / accuracy order:
 *
 *   1. **Per-project embedding classifier** (async; loaded from
 *      `project_embedding_classifiers` table via
 *      `embedding-classifier-loader.ts`). Same shape / contract as the
 *      global classifier, but trained per-tenant. Used automatically
 *      when a projectId is available AND that project has an active
 *      row. Cached per-project for 60s with pg_notify fan-out.
 *   2. **Global embedding classifier** (`embedding-classifier.ts`,
 *      opted in via env). Sub-millisecond, no per-request LLM cost,
 *      learns from every tenant's traffic merged.
 *   3. **Regex heuristic** (this file's body). Runs when no embedding
 *      artifact is loaded OR when the embedding classifier returned
 *      low-confidence. This is the cold-start path and the safety net.
 *   4. (Optional) **LLM judge** for the difficulty score, gated by
 *      `TOKENSMART_CLASSIFIER_MODEL`. Lives in `classifier.ts`. It only
 *      affects the [0,1] difficulty score, not task_type — orthogonal
 *      to this file's machinery.
 *
 * Both embedding layers have the same confidence-gating semantics:
 * we trust the prediction only when BOTH heads (task_type + complexity)
 * cross the artifact's calibrated softmax thresholds; otherwise we
 * DEFER to the heuristic. That keeps an under-trained per-tenant
 * artifact from silently regressing routing.
 *
 * The buckets match exactly what the baseline policy artifact
 * produces, so runtime classification and offline training stay aligned.
 */

/**
 * Content keywords that mark a request as code-oriented. Three sources of
 * signal layered into a single regex:
 *
 *   1. English programming verbs / nouns (function, class, refactor, …)
 *      plus fenced code-block language hints (```py / ```ts / …).
 *   2. Chinese programming vocabulary (函数 / 类 / 重构 / 调试 / 报错 / …).
 *      These are 2–4 character compound words, so we can't rely on \b
 *      word boundaries (CJK has no word separators); we match them as
 *      substring patterns instead. That's how the original Chinese
 *      reasoning keywords (below) have always been matched too.
 *   3. Japanese programming vocabulary (関数 / クラス / リファクタ / デバッグ).
 *      Same substring-match rationale.
 *
 * The English set uses word boundaries for precision ("return " with
 * trailing space avoids matching "returnable"); the CJK sets rely on
 * substring match, which is correct for those scripts.
 */
const CODE_KEYWORDS =
  /\b(function|class |def |const |let |var |import |#include|public static|return |refactor|bug|stack trace|compile|unittest|pytest|debug|typescript|javascript|python|golang|rust code)\b|```(py|python|ts|typescript|js|javascript|java|go|rust|cpp|c\+\+)\b|(函数|方法|类|接口|重构|实现|代码|编译|报错|错误信息|调试|单元测试|单测|异常|栈回溯|堆栈|语法错误|改写这段|写一段|写个|实现一个|类型错误|关键字|关键词|重构一下|重构下)|(関数|クラス|メソッド|実装|リファクタ|リファクタリング|デバッグ|コンパイル|ユニットテスト|エラー|スタックトレース|例外|書き直|コード)/i;

/**
 * Reasoning vocabulary — asks that require multi-step analysis, proofs,
 * or comparative evaluation. Expanded Chinese set (论证 / 推导 / 分析 /
 * 证明 / 为什么 / 解释 / 比较 / 评估 / 权衡 / 推理 / 策略 / 思考) plus a
 * Japanese set (分析 / 推論 / 証明 / 説明 / 比較 / 評価 / 推敲).
 */
const REASONING_KEYWORDS =
  /\b(prove|derive|analy[sz]e|analysi[sz]|critique|explain why|explain how|deep.dive|implication|consequence|strategy|argument|compare|evaluate|weigh|reasoning|justify|rationale)\b|(论证|推导|分析|证明|为什么|为何|解释|比较|对比|评估|权衡|推理|策略|思考|思路|原理|为啥)|(分析|推論|証明|説明|比較|評価|推敲|考察|論証|論理|解説)/i;

/**
 * Figure out which `TaskType` an incoming chat request represents.
 *
 * Precedence — CONTENT-driven first, harness-shape last. The previous
 * version (`tool_use` wins whenever `tools[]` is non-empty) misclassified
 * every OpenClaw turn — even "Hi" — as `tool_use`, because OpenClaw
 * always ships its full toolset on every chat completion. The router
 * then bucketed those turns under reasoning policy, where flash-lite
 * doesn't pass the quality floor, and the policy refused to downgrade.
 *
 * Updated order:
 *   1. CODE_KEYWORDS in the user text (user explicitly asked for code)
 *   2. REASONING_KEYWORDS in the user text (prove/analyze/derive...)
 *   3. tools[] non-empty AND user content not obviously trivial chat
 *      (the agent is set up for tool use AND the user is plausibly
 *      asking it to do tool work) → tool_use
 *   4. fall back to chat
 *
 * Trivial-chat detection is the same regex as `complexityScore`'s
 * trivial-cap (greetings, "thanks", "ok") so the two layers agree.
 */
/**
 * Greetings / acknowledgements / pings that classify as trivial chat even
 * if the harness ships tools[] or a long session. Covers English + Chinese
 * (simplified) + Japanese (romaji + kana + kanji). Used by both
 * `inferTaskType` (to stop tools[] from misclassifying a greeting as
 * tool_use) and `complexityScore` (to cap the difficulty score).
 */
const TRIVIAL_CHAT =
  /^\s*(hi|hello|hey|yo|hiya|sup|morning|good morning|good evening|howdy|你好|哈喽|嗨|哈咯|早上好|晚上好|在吗|在不在|thanks?|thank you|thx|cheers|谢谢|多谢|感谢|ok(ay)?|kk|got it|好的|好|明白|了解|ping|test|testing|こんにちは|こんばんは|おはよう|ありがとう|ありがとうございます|よろしく|はい|了解です)[\s!?.。,，、]*$/i;

function inferTaskType(body: OpenAIChatRequest, lastUserText: string): TaskType {
  // v0.6.6 — strip agent-harness wrapper from the user's last message
  // before keyword + length checks. Two distinct wrapper modes both
  // historically broke this:
  //
  //   (a) Multi-modal content array — `[{type:"text",text:"..."}]`.
  //       v0.6.0's `extractLastUserText` JSON.stringify'd the whole
  //       array, so `[{"text":"hi","type":"text"}]` (29 chars wrapped
  //       to 58) escaped both TRIVIAL_CHAT and the `< 30` length cap,
  //       was tagged tool_use, fell through to reasoning:medium, and
  //       refused to downgrade. Fixed at extraction layer (see
  //       `extractLastUserText` below).
  //
  //   (b) Multi-paragraph wrapper — LangChain / "system message in
  //       user role" style: instructions prepended to the user's
  //       actual ask, separated by blank lines. `extractUserIntent`
  //       takes the trailing paragraph when the wrapper signature is
  //       present, so a `Use the following tools: ...\n\n你好` falls
  //       back to `你好` for classification purposes.
  //
  // Both happen in the wild; we strip them in extraction so the
  // downstream regexes + length checks see what the user actually
  // typed, not what the harness wrapped around it.
  const intent = extractUserIntent(lastUserText);

  if (CODE_KEYWORDS.test(intent)) return "code";
  if (REASONING_KEYWORDS.test(intent)) return "reasoning";
  const toolsAvailable =
    Array.isArray(body.tools) && body.tools.length > 0;
  if (toolsAvailable) {
    // Tools are configured but the user's actual text reads like plain
    // chat (greeting / one-liner / short ask). Don't misclassify it
    // as tool_use just because the harness exposes tools — let chat
    // bucket and routing handle it.
    const trivialChat =
      TRIVIAL_CHAT.test(intent) || intent.trim().length < 30;
    if (!trivialChat) return "tool_use";
  }
  return "chat";
}

/**
 * Pull the user's most recent message text out of an OpenAI-shaped chat
 * request. Handles three content shapes that all show up in real
 * traffic:
 *
 *   1. **String content** — the classic OpenAI / Anthropic shape; the
 *      content field IS the text.
 *   2. **Multi-modal content array** — `[{type:"text",text:"..."},
 *      {type:"image_url",image_url:{url:"..."}}]`. OpenAI's vision
 *      and the OpenAI v2 SDK use this. Extract every text part and
 *      join with newlines; image / audio / file parts contribute no
 *      classification signal so we drop them.
 *   3. **Anything else** — fall back to JSON.stringify so we have at
 *      least *some* text for keyword regexes. We do NOT use the
 *      stringified result for length-based heuristics in the caller —
 *      callers should be defensive about the worst case.
 *
 * v0.6.6 fix: the previous version stringified the multi-modal array
 * verbatim, which inflated `[{"text":"hi","type":"text"}]` from a
 * 29-char user intent to a 58-char wrapped string — long enough to
 * defeat both `TRIVIAL_CHAT` and the `< 30` length cap, so OpenClaw
 * (which always wraps user content in vision-mode array even for
 * pure-text turns) was misclassified as tool_use:medium.
 */
export function extractLastUserText(body: OpenAIChatRequest): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  if (!lastUser) return "";
  return extractTextFromContent(lastUser.content);
}

/**
 * Pure helper, exported for cross-file use (`classifier.ts`'s
 * `complexityScore` shares the same wire-format handling) + tests.
 *
 * Intentionally lenient about array element shape — different SDKs
 * use slightly different field naming (`text` vs `value` vs nested
 * `text.value`); we accept any element that has a string `text` or
 * a string `value` property. Image/audio/file parts (which carry
 * `image_url`, `image`, `audio_url`, `file` keys but NO `text`
 * field) contribute no classification signal and get dropped.
 */
export function extractTextFromContent(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c) {
      if (part == null) continue;
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (typeof part === "object") {
        const o = part as Record<string, unknown>;
        if (typeof o.text === "string") {
          parts.push(o.text);
          continue;
        }
        // Anthropic and some adapters use `value` instead of `text`
        // for the textual content. Defensive — picks up either.
        if (typeof o.value === "string") {
          parts.push(o.value);
          continue;
        }
      }
    }
    if (parts.length > 0) return parts.join("\n");
    // Array with no recognizable text parts (image-only, etc.) —
    // fall through to stringify so we have *some* signal for the
    // keyword regexes, but the trivial-chat / length checks should
    // not trust this length.
    try {
      return JSON.stringify(c);
    } catch {
      return String(c);
    }
  }
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

/**
 * Strip a prepended agent-harness wrapper from a user message and
 * return the user's actual ask.
 *
 * The pattern this catches: agents like LangChain / OpenClaw in some
 * configurations prepend a block of instructions to the user's
 * question, separated from the real ask by one or more blank lines:
 *
 *   ```
 *   You are a helpful assistant. Use the following tools: ...
 *   When the user asks X, do Y. Always reply in markdown. ...
 *
 *   你是谁?
 *   ```
 *
 * Without stripping, the wrapper's length + keyword vocabulary
 * dominates classification — even though the user's actual intent is
 * a 4-character greeting. We pull out the trailing paragraph as the
 * intent signal whenever:
 *
 *   - The text has multiple paragraphs (separated by `\n\s*\n+`), AND
 *   - The trailing paragraph is at most `INTENT_MAX_TAIL_CHARS`
 *     characters (i.e. it looks like a short user ask, not a
 *     continuation of the wrapper).
 *
 * Single-paragraph text passes through unchanged, so a user who genuinely
 * types a long single-paragraph essay still gets classified on the full
 * content. Multi-paragraph text where the trailing paragraph is ALSO
 * long passes through unchanged too — that's a real multi-paragraph
 * user ask, not a wrapped intent.
 *
 * No-op when the wrapper is in the SYSTEM message (the OpenAI-canonical
 * shape) — we only ever look at the user message in this file. Wrapper-
 * in-system is the right architectural choice and we recommend it; the
 * wrapper-in-user-message strip exists only to be safe with agents that
 * choose differently.
 */
// Real user multi-paragraph descriptions usually have substantive
// trailing paragraphs (≥ 80 chars in practice). Wrapper-prepended
// intent is almost always SHORT (greeting, one-line ask). Setting the
// strip threshold conservatively below typical "real description"
// length protects existing classifier behavior on legitimate
// multi-paragraph user content.
const INTENT_MAX_TAIL_CHARS = 80;
const PARAGRAPH_BREAK = /\n\s*\n+/;

/**
 * Noise-prefix patterns harnesses commonly prepend that contribute no
 * intent signal. Each pattern is anchored at start-of-string and
 * applied iteratively (a single user message can stack a timestamp
 * AND a bracket-tag AND a system-context block).
 *
 * Curated from real wire captures, NOT speculation:
 *
 *   - `[Fri 2026-04-24 16:00 PDT] ` — OpenClaw's per-turn timestamp.
 *     Costs 26+ chars on a 4-char "你是谁?" intent, breaking the
 *     `< 30` length cap that drives trivial-chat detection.
 *   - `[Bootstrap pending]\n...directive lines...\n` — OpenClaw's
 *     workspace-bootstrap indicator (and similar `[Persona]` /
 *     `[System]` / `[Context]` brackets).
 *   - `<system_context>...</system_context>` — XML-fenced harness
 *     context, common in LangChain templates.
 *
 * Each pattern strips its match + any trailing whitespace. We DON'T
 * try to be exhaustive — a wrapper we don't recognize falls through
 * to the paragraph-split heuristic below, which catches most of the
 * remaining shapes (multi-paragraph wrapper + short trailing intent).
 */
const NOISE_PREFIX_PATTERNS: RegExp[] = [
  // Timestamp prefix: `[Fri 2026-04-24 16:00 PDT] `
  /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+[A-Z]{2,5}\]\s*/,
  // Single-line bracket tag at start: `[Bootstrap pending]\n` /
  // `[System]\n` / `[Persona]\n` etc. Multi-line directive bodies
  // get caught by the paragraph-split logic later (they end with a
  // blank line before the real intent).
  /^\[(?:Bootstrap|System|Persona|Context|Note|Identity)[^\]\n]*\]\s*\n+/i,
  // XML-fenced harness context block at start.
  /^<system[_-]?context>[\s\S]*?<\/system[_-]?context>\s*/i,
];

function stripNoisePrefix(text: string): string {
  let result = text;
  // Iterate so stacked prefixes (timestamp + bracket + system_context)
  // all get peeled. Bounded to 5 passes — pathological input can't
  // hold us in a loop.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const rx of NOISE_PREFIX_PATTERNS) {
      const next = result.replace(rx, "");
      if (next !== result) {
        result = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

export function extractUserIntent(rawText: string): string {
  if (!rawText) return rawText;
  // Strip noise prefix FIRST so the paragraph-split below sees the
  // user's real ask without a 26-char timestamp inflating it past
  // the trivial cap.
  const stripped = stripNoisePrefix(rawText.trim()).trim();
  if (!stripped.includes("\n")) return stripped;

  // Strong "this is a real user description, not a wrapper" signal:
  // a code fence appears anywhere → user is showing/asking about
  // code, the whole message is intent. Bail out of strip path —
  // "Please refactor this fn:\n\n```rust...```\n\nDerive lock order"
  // is a single user task across paragraphs, not a wrapper-then-intent.
  if (stripped.includes("```")) return stripped;

  const paragraphs = stripped
    .split(PARAGRAPH_BREAK)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length <= 1) return stripped;

  // Take the trailing paragraph as the real intent ONLY when it's
  // short enough to plausibly be an isolated user ask (rather than a
  // continuation of a multi-paragraph user description).
  // INTENT_MAX_TAIL_CHARS = 80 is calibrated against the existing
  // classifier-test corpus: real user multi-paragraph descriptions
  // (the "Please refactor + Derive lock contention" case) have
  // trailing paragraphs ≥ 82 chars and stay un-stripped; agent-
  // wrapped intents (`你你是谁?`, `Hi`, `Write isPrime`) are well
  // under 80 and strip cleanly.
  const tail = paragraphs[paragraphs.length - 1]!;
  if (tail.length <= INTENT_MAX_TAIL_CHARS) return tail;
  return stripped;
}

/**
 * Map a `[0,1]` complexity score into the 4-bucket scheme used by the
 * baseline policy. Thresholds chosen to roughly match what the `heuristic`
 * scorer produces on real traffic:
 *
 *   - simple  < 0.25   ("hi", short Q&A, template fills)
 *   - medium  0.25–0.6 (most real tasks, short-to-medium prompts)
 *   - hard    0.6–0.85 (long context, multi-message, tools, code blocks)
 *   - frontier ≥ 0.85  (repo-scale / high-risk agent work; keep flagship)
 */
function bucketFromScore(score: number): ComplexityBucket {
  if (score < 0.25) return "simple";
  if (score < 0.6) return "medium";
  if (score < 0.85) return "hard";
  return "frontier";
}

export interface TaskClassification {
  task_type: TaskType;
  complexity: ComplexityBucket;
  /** The raw `[0,1]` complexity score, for logging and metrics. */
  complexity_score: number;
}

export type TaskClassificationOptions = {
  /**
   * Optional async LLM-judge score supplied by the router. Keeping this as an
   * input avoids a circular dependency from policy/task-classifier.ts back into
   * classifier.ts's provider/BYO resolution logic.
   */
  complexityScoreOverride?: number;
};

/**
 * Synchronous classifier. Uses the global embedding artifact if loaded,
 * otherwise falls back to the heuristic. This is the fast path when
 * the caller has no project context (e.g. the aggregator operating on
 * archival rows after the fact, or an unauthenticated code path).
 *
 * For the chat route hot path, prefer `classifyTaskForProject` — it's
 * async-capable but picks up the per-tenant artifact when available.
 */
export function classifyTask(body: OpenAIChatRequest): TaskClassification {
  const emb = classifyWithEmbedding(body);
  if (emb && emb.confident) {
    return {
      task_type: emb.task_type,
      complexity: emb.complexity,
      complexity_score: emb.complexity_score,
    };
  }
  return heuristicOnly(body);
}

/**
 * Project-aware classifier. Tries per-project active artifact first
 * (DB + cache), then global artifact (file), then the heuristic. Called
 * from the chat hot path where `projectId` is already resolved via auth.
 *
 * When `projectId` is null or the lookup fails, this is behaviorally
 * identical to the sync `classifyTask` — zero regression vs pre-v0.7
 * for unauthenticated / no-project callers.
 */
export async function classifyTaskForProject(
  body: OpenAIChatRequest,
  projectId: string | null,
  opts: TaskClassificationOptions = {}
): Promise<TaskClassification> {
  let artifact: ClassifierArtifact | null = null;
  try {
    artifact = await loadActiveEmbeddingClassifier(projectId);
  } catch (err) {
    // Loader errors must not degrade routing. Fall back to sync path.
    console.warn(
      `[task-classifier] per-project classifier lookup failed for ${projectId ?? "<null>"}: ${(err as Error).message} — using global/heuristic`
    );
  }
  const emb = classifyWithEmbedding(body, artifact);
  if (emb && emb.confident) {
    return {
      task_type: emb.task_type,
      complexity: emb.complexity,
      complexity_score: emb.complexity_score,
    };
  }
  return heuristicOnly(body, opts);
}

function heuristicOnly(
  body: OpenAIChatRequest,
  opts: TaskClassificationOptions = {}
): TaskClassification {
  const text = extractLastUserText(body);
  const task_type = inferTaskType(body, text);
  const score = opts.complexityScoreOverride ?? complexityScore(body);
  return {
    task_type,
    complexity: bucketFromScore(score),
    complexity_score: score,
  };
}
