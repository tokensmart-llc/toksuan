import { createHash } from "node:crypto";
import type { OpenAIChatRequest } from "./providers/openai";
import { env, findProviderTemplate, pickProvider, type ProviderConfig } from "./config";
import { resolveProvider } from "./provider-resolve";
import { callUpstream } from "./providers/openai";
import { callAnthropic } from "./providers/anthropic";
import {
  extractTextFromContent,
  extractUserIntent,
} from "./policy/task-classifier";

/**
 * Cheap heuristic complexity score in [0, 1].
 *
 *   ~0.0  trivial: "hi", "thanks", "ok"
 *   ~0.3  baseline
 *   ~0.6+ real task: code, design, long context written by the user
 *
 * Design rule: the score reflects what the **user is asking for in this
 * single turn**, not the shape of the agent harness wrapped around it.
 * An OpenClaw turn that ships a 12k-token system prompt and 30 tool
 * definitions for a "Hi" message is still a "Hi" — the policy should
 * downgrade it. Earlier versions of this file added +0.25 for the mere
 * presence of `tools[]` and +0.15 for any session ≥ 5 messages, which
 * silently inflated trivial OpenClaw turns into the medium bucket and
 * sent every greeting to the expensive model. Both signals were
 * describing the AGENT FORMAT, not per-turn intent — they're now used
 * for `task_type` classification (see policy/task-classifier.ts) but
 * NOT for difficulty.
 *
 * The router downgrades when this score is below the rule's threshold.
 * False routing-down (analytical task → cheap model) is the costly
 * failure; false routing-up (greeting → pro model) is a few extra
 * cents. We bias upward whenever the actual user content suggests
 * real work, but we DON'T bias upward just because the harness is
 * heavy.
 */
export function complexityScore(body: OpenAIChatRequest): number {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMsgs = messages.filter((m) => m?.role === "user");
  const lastUser = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : undefined;

  // v0.6.6 — same multi-modal-array + harness-wrapper strip logic
  // task-classifier.ts uses for `inferTaskType`. Pre-fix this function
  // ran `JSON.stringify(content)` on the raw vision-mode array, so a
  // 4-char "你是谁?" wrapped as `[{"text":"...","type":"text"}]`
  // bloated to 50+ chars and skipped the < 30 trivial cap, putting the
  // request in `medium` instead of `simple`. The fix is the same
  // helper the task-type classifier uses, so length-based heuristics
  // here and over there agree on what "the user actually typed".
  const rawText = lastUser ? extractTextFromContent(lastUser.content) : "";
  const text = extractUserIntent(rawText);

  let score = 0.2;

  const len = text.trim().length;
  if (len < 30) score -= 0.15;
  else if (len < 100) score -= 0.05;
  else if (len < 500) score += 0.2;
  else score += 0.35;

  if (/```/.test(text)) score += 0.3;
  if ((text.match(/\n/g)?.length ?? 0) >= 3) score += 0.1;

  // Multi-turn session is a WEAK signal — the conversation may be 50
  // messages deep but THIS turn might be "thanks". Keep a small bump
  // (a long session correlates with "the user is engaged enough to
  // follow up on quality") but nothing close to a bucket-shift on its
  // own. Note: `tools[]` presence is no longer scored here at all —
  // see the docblock above for the reasoning.
  if (messages.length >= 5) score += 0.05;

  // Tasks that usually need the bigger model.
  const complexKw =
    /\b(analy[sz]e|analysi[sz]|architect|design|derive|prove|optimi[sz]e|debug|refactor|implement|compare|critique|research|strategy|explain how|deep.dive)\b/i;
  if (complexKw.test(text)) score += 0.2;

  // Greetings / acknowledgments. Short trivia only — don't over-claim.
  const trivial =
    /^\s*(hi|hello|hey|yo|你好|哈喽|嗨|thanks?|thank you|thx|谢谢|ok(ay)?|好的|好|ping|test)[\s!?.。,，]*$/i;
  if (trivial.test(text)) score = Math.min(score, 0.15);

  // Belt-and-braces cap on very short USER content. The trivial regex
  // above only catches a fixed greeting list, but a user typing
  // "format date?" or "next step?" through OpenClaw still has trivial
  // intent — the agent harness should not push them above the simple
  // bucket. If a user genuinely wants a deep answer to a 25-character
  // question, they'll expand the question; the LLM judge (when
  // enabled via TOKENSMART_CLASSIFIER_MODEL) catches the rare case
  // where short text really means a hard ask.
  if (len > 0 && len < 30) score = Math.min(score, 0.2);

  return Math.max(0, Math.min(1, score));
}

// =========================================================================
// LLM-judge classifier (optional, env-flagged)
// =========================================================================
//
// When TOKENSMART_CLASSIFIER_MODEL is set, the gateway asks that small fast
// model to score complexity instead of running the regex heuristic. Cached
// in-memory so a tight agent loop doesn't pay a judge call per turn.

const JUDGE_CACHE_MAX = 2000;
const JUDGE_TIMEOUT_MS = 1500;
const judgeCache = new Map<string, number>();

const SAME_PROVIDER_JUDGE_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  google: "gemini-2.5-flash-lite",
  deepseek: "deepseek-chat",
  qwen: "qwen-plus",
  doubao: "doubao-seed-2-0-mini-260215",
};

export type ClassifierOptions = {
  userId?: string | null;
  requestedModel?: string;
  classifierModelOverride?: string | null;
};

function judgeKey(model: string, text: string, userId?: string | null): string {
  return createHash("sha256")
    .update(`${userId ?? "env"}\0${model}\0${text.slice(0, 800)}`)
    .digest("hex")
    .slice(0, 24);
}

function pruneJudgeCache(): void {
  if (judgeCache.size <= JUDGE_CACHE_MAX) return;
  // Drop the oldest insertion (Map preserves insertion order).
  const drop = judgeCache.size - Math.floor(JUDGE_CACHE_MAX * 0.9);
  let i = 0;
  for (const k of judgeCache.keys()) {
    judgeCache.delete(k);
    if (++i >= drop) break;
  }
}

/**
 * v0.6.6 — was a local duplicate of task-classifier.ts's
 * extractLastUserText with the same multi-modal-array bug. Now
 * delegates to the shared helper + applies the wrapper-strip pass
 * so the judge sees what the user actually typed (and so the cache
 * key is invariant under wrapper variation across turns — same
 * intent, same hash, same cache hit).
 */
function extractLastUserText(body: OpenAIChatRequest): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  if (!lastUser) return "";
  const raw = extractTextFromContent(lastUser.content);
  return extractUserIntent(raw);
}

async function judgeComplexity(
  body: OpenAIChatRequest,
  judgeModel: string,
  provider: ProviderConfig,
  userId?: string | null
): Promise<number | null> {
  const text = extractLastUserText(body);
  if (!text.trim()) return null;

  const cacheKey = judgeKey(judgeModel, text, userId);
  const cached = judgeCache.get(cacheKey);
  if (cached != null) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);

  try {
    const judgeBody: OpenAIChatRequest = {
        model: judgeModel,
        temperature: 0,
        max_tokens: 6,
        messages: [
          {
            role: "system",
            content:
              "You rate task complexity. Reply with EXACTLY one number from 0 to 100. " +
              "0 = trivial chitchat. 30 = baseline question. 70 = real coding/analysis. " +
              "100 = research-grade. NO words, NO punctuation, just the integer.",
          },
          { role: "user", content: text.slice(0, 2000) },
        ],
    };
    const result =
      provider.name === "anthropic"
        ? await callAnthropic(judgeBody, provider)
        : await callUpstream(judgeBody, provider);
    if (result.status < 200 || result.status >= 300) return null;
    const bodyJson = result.body as {
      choices?: Array<{ message?: { content?: unknown } }>;
      content?: Array<{ type?: string; text?: string }>;
    };
    const raw =
      bodyJson.choices?.[0]?.message?.content ??
      bodyJson.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
    if (typeof raw !== "string") return null;
    const m = raw.match(/(\d{1,3})/);
    if (!m) return null;
    const n = Math.max(0, Math.min(100, Number(m[1])));
    const score = n / 100;
    judgeCache.set(cacheKey, score);
    pruneJudgeCache();
    return score;
  } catch {
    // Timeout, network, JSON shape — any failure falls through to heuristic.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sameProviderJudgeModel(requestedModel: string | undefined): string | null {
  if (!requestedModel) return null;
  const provider = findProviderTemplate(requestedModel)?.name;
  if (!provider) return null;
  return SAME_PROVIDER_JUDGE_MODEL[provider] ?? null;
}

async function resolveJudgeProvider(
  judgeModel: string,
  userId: string | null | undefined,
  allowEnv: boolean
): Promise<ProviderConfig | null> {
  const resolved = await resolveProvider(userId ?? null, judgeModel);
  if (resolved.ok) {
    if (resolved.source === "env" && !allowEnv && userId) return null;
    return resolved.config;
  }
  if (allowEnv) return pickProvider(judgeModel, env.providers);
  return null;
}

async function chooseJudge(
  opts: ClassifierOptions
): Promise<{ model: string; provider: ProviderConfig } | null> {
  if (env.TOKENSMART_CLASSIFIER_MODE === "heuristic") return null;

  const headerOverride = opts.classifierModelOverride?.trim();
  if (headerOverride) {
    const provider = await resolveJudgeProvider(headerOverride, opts.userId, false);
    return provider ? { model: headerOverride, provider } : null;
  }

  if (env.TOKENSMART_CLASSIFIER_MODE === "explicit" && env.TOKENSMART_CLASSIFIER_MODEL) {
    const provider = await resolveJudgeProvider(env.TOKENSMART_CLASSIFIER_MODEL, opts.userId, true);
    return provider ? { model: env.TOKENSMART_CLASSIFIER_MODEL, provider } : null;
  }

  const sameProvider = sameProviderJudgeModel(opts.requestedModel);
  if (!sameProvider) return null;
  const provider = await resolveJudgeProvider(sameProvider, opts.userId, false);
  return provider ? { model: sameProvider, provider } : null;
}

/**
 * Public entry point used by the router. Uses the LLM judge when configured,
 * otherwise falls back to the heuristic. Always async so callers can swap
 * implementations without the call site changing.
 */
export async function scoreComplexity(
  body: OpenAIChatRequest,
  opts: ClassifierOptions = {}
): Promise<number> {
  const judge = await chooseJudge({
    ...opts,
    requestedModel: opts.requestedModel ?? String(body.model ?? ""),
  });
  if (judge) {
    const judged = await judgeComplexity(body, judge.model, judge.provider, opts.userId);
    if (judged != null) return judged;
  }
  return complexityScore(body);
}
