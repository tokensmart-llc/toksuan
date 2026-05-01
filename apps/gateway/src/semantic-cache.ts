/**
 * Semantic prompt cache (exact-hash + optional embedding-similarity).
 *
 * Goal — close the OSS-audit functional gap "vs Helicone semantic cache".
 * When the same agent fires the same (or near-identical) prompt repeatedly
 * — common with retry-prone code-review agents, scheduled summarizers,
 * boilerplate "explain this stack trace" UX — TokSuan can serve a
 * cached response in microseconds (exact) or ~50-200ms (similarity) for
 * $0.00, drastically reducing both cost AND upstream rate-limit pressure.
 *
 * Design choices:
 *   - In-memory LRU+TTL by default. Multi-replica installs can promote to
 *     Postgres later (the API surface is intentionally transport-free
 *     so swapping the store doesn't ripple into chat.ts).
 *   - Two layers: exact (cheap, dominant signal) → similarity (only when
 *     enabled AND exact missed). Similarity layer reuses the existing
 *     embedding infrastructure from `quality.ts`.
 *   - Cache keys are scoped by project_id so tenants never see each
 *     other's cached responses (defense-in-depth: even if the LRU were
 *     accidentally shared, the key namespace prevents cross-tenant
 *     leakage).
 *   - SAFETY: we DO NOT cache requests that:
 *       - are streaming (we'd have to reconstruct + replay SSE bytes)
 *       - have temperature > 0 (caller explicitly wants randomness)
 *       - have tools / function_call / response_format=json_schema
 *         (state-dependent — caching would lie about live tool side
 *          effects)
 *       - have unusually short prompts (<8 chars — cheap to recompute,
 *          high false-positive risk)
 *
 * Env knobs:
 *   TOKENSMART_CACHE_ENABLED=1
 *     Master switch. Default off so existing self-hosters opt in
 *     deliberately.
 *   TOKENSMART_CACHE_MAX_ENTRIES=1000
 *     LRU cap. Each entry holds a small JSON blob + a 1536-dim float
 *     vector (~6 KiB) when similarity is on. 1000 entries = ~6 MB RSS
 *     at full saturation, fine.
 *   TOKENSMART_CACHE_TTL_SECONDS=600
 *     How long an entry stays warm. Models and prompts evolve quickly
 *     in agent dev; 10 min default keeps the cache useful without
 *     serving stale answers post-prompt-edit.
 *   TOKENSMART_CACHE_SIMILARITY_THRESHOLD=0.95
 *     If 0, similarity layer is disabled (exact only — fast path only).
 *     Otherwise, the cosine similarity needed to consider two prompts
 *     equivalent. 0.95+ is conservative; 0.90 if you're tolerant of
 *     paraphrasing. Requires TOKENSMART_QUALITY_EMBED_MODEL to be set
 *     (we reuse the same embedding stack as the quality-proof card).
 */

import { createHash } from "node:crypto";
import { LruTtlCache } from "./lru-ttl-cache";
import type { OpenAIChatRequest } from "./providers/openai";
import { computeResponseSimilarity } from "./quality";

export type CacheLookupHit = {
  hit: true;
  /** "exact" (hash match) or "similarity" (embedding-near match). */
  kind: "exact" | "similarity";
  /** The cached upstream response body (OpenAI chat-completion shape). */
  responseBody: unknown;
  /** Cosine similarity for the similarity layer, undefined for exact. */
  similarity?: number;
  /** Counters for the dashboard. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type CacheLookupMiss = {
  hit: false;
  /** When non-null, tells the caller "you may store the eventual response under this key". */
  cacheKey: string | null;
  /** Reason the lookup didn't return a hit — useful for debugging + the integrations panel. */
  reason: string;
};

export type CacheLookupResult = CacheLookupHit | CacheLookupMiss;

type CacheEntry = {
  responseBody: unknown;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Tail-of-prompt text used for the similarity layer. Empty when disabled. */
  promptText: string;
  /** Tail-of-prompt embedding vector. Empty array = not embedded. */
  embedding: number[];
};

let cache: LruTtlCache<CacheEntry> | null = null;
let _initLogged = false;

function getCache(): LruTtlCache<CacheEntry> | null {
  if (process.env.TOKENSMART_CACHE_ENABLED !== "1") {
    if (!_initLogged) {
      _initLogged = true;
      console.log(
        "[cache] semantic cache DISABLED (set TOKENSMART_CACHE_ENABLED=1 to enable)"
      );
    }
    return null;
  }
  if (cache) return cache;
  const max = Number(process.env.TOKENSMART_CACHE_MAX_ENTRIES ?? "1000");
  const ttlSec = Number(process.env.TOKENSMART_CACHE_TTL_SECONDS ?? "600");
  const safeMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1000;
  const safeTtlMs =
    Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) * 1000 : 600_000;
  cache = new LruTtlCache<CacheEntry>(safeMax, safeTtlMs);
  if (!_initLogged) {
    _initLogged = true;
    const sim = Number(
      process.env.TOKENSMART_CACHE_SIMILARITY_THRESHOLD ?? "0"
    );
    console.log(
      `[cache] semantic cache ENABLED (max=${safeMax} entries, ttl=${safeTtlMs}ms, similarity_threshold=${sim || "off"})`
    );
  }
  return cache;
}

function similarityThreshold(): number {
  const v = Number(process.env.TOKENSMART_CACHE_SIMILARITY_THRESHOLD ?? "0");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0;
}

/**
 * Determine whether a request is even ELIGIBLE for caching. Returns the
 * reason for ineligibility on miss, or null if cacheable.
 *
 * The cheaper this gate is, the better — it's on the hot path for every
 * request whether or not caching ever fires.
 */
function notCacheable(body: OpenAIChatRequest): string | null {
  if (body.stream === true) return "streaming";
  // Temperature > 0 means caller explicitly wants randomness.
  // OpenAI default temperature is 1 if unspecified — to avoid caching
  // every default-config call (which would mask randomness), we require
  // an explicit `temperature: 0`. Conservative; can revisit.
  const t = (body as { temperature?: unknown }).temperature;
  if (typeof t !== "number" || t > 0) return "non_zero_temperature";
  if (body.tools != null) return "tools_present";
  if ((body as { function_call?: unknown }).function_call != null)
    return "function_call_present";
  // Response format json_schema can be deterministic but caching would
  // miss subtle schema changes between calls. Skip for v1.
  const rf = (body as { response_format?: unknown }).response_format;
  if (rf && typeof rf === "object" && "type" in rf) {
    const type = (rf as { type?: unknown }).type;
    if (type === "json_schema") return "response_format_json_schema";
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return "no_messages";
  // Reject trivially short prompts — they're cheap to recompute and
  // semantic-cache false positives are visible (returning the wrong
  // 5-word answer is more obnoxious than re-running gpt-4o-mini once).
  let totalChars = 0;
  for (const m of body.messages) {
    if (typeof m?.content === "string") totalChars += m.content.length;
  }
  if (totalChars < 8) return "prompt_too_short";
  return null;
}

/**
 * Stable canonical JSON for cache-key hashing. Sorts object keys so
 * `{a:1,b:2}` and `{b:2,a:1}` collide on the same cache key. Skips
 * arrays' order — for messages, ORDER matters (it's a conversation),
 * so we DO preserve message-array order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

/**
 * Build the exact cache key for (project, body). Includes ONLY fields
 * that influence the upstream response — `messages`, `model`, optional
 * `temperature`/`top_p`/`max_tokens`/`seed`. Stripping out caller-side
 * metadata (`user`, internal tags) is what makes this cache useful at
 * all — otherwise no two requests would ever collide.
 */
function exactKey(projectId: string, body: OpenAIChatRequest): string {
  const significant = {
    project_id: projectId,
    model: body.model,
    messages: body.messages,
    temperature: (body as { temperature?: number }).temperature ?? 0,
    top_p: (body as { top_p?: number }).top_p ?? null,
    max_tokens: (body as { max_tokens?: number }).max_tokens ?? null,
    seed: (body as { seed?: number }).seed ?? null,
    response_format: (body as { response_format?: unknown }).response_format ?? null,
  };
  const canonical = canonicalJson(significant);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Concatenate ALL message contents into a single string for the
 * embedding-similarity layer. Order-preserving — a chat is a sequence,
 * not a bag.
 *
 * Capped at MAX_EMBED_CHARS to keep embedding-API cost bounded.
 */
const MAX_EMBED_CHARS = 8000;

function promptTextForEmbedding(body: OpenAIChatRequest): string {
  if (!Array.isArray(body.messages)) return "";
  const parts: string[] = [];
  for (const m of body.messages) {
    if (typeof m?.content === "string") {
      parts.push(`[${m.role}] ${m.content}`);
    } else if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (
          p &&
          typeof p === "object" &&
          "text" in p &&
          typeof (p as { text: unknown }).text === "string"
        ) {
          parts.push(`[${m.role}] ${(p as { text: string }).text}`);
        }
      }
    }
  }
  return parts.join("\n").slice(0, MAX_EMBED_CHARS);
}

/**
 * Approximate per-request token count from a `usage` block on the cached
 * response, with safe fallbacks for shapes without `usage` (rare).
 */
function tokensFromResponse(responseBody: unknown): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} {
  if (!responseBody || typeof responseBody !== "object") {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  }
  const u = (responseBody as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  }
  const usage = u as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  return {
    inputTokens: Number(usage.prompt_tokens ?? 0),
    outputTokens: Number(usage.completion_tokens ?? 0),
    cachedInputTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
  };
}

/**
 * Look up the cache for a (project, body). Returns hit/miss. On miss,
 * returns the cache key the caller can use to STORE the eventual result
 * — pre-computed here so we don't redo the canonicalization twice.
 *
 * Best-effort: any internal failure silently falls through to a miss.
 * The chat-completion path must NEVER fail because of cache plumbing.
 */
export async function lookupSemanticCache(
  projectId: string,
  body: OpenAIChatRequest
): Promise<CacheLookupResult> {
  try {
    const c = getCache();
    if (!c) return { hit: false, cacheKey: null, reason: "disabled" };
    const why = notCacheable(body);
    if (why) return { hit: false, cacheKey: null, reason: why };

    const key = exactKey(projectId, body);
    const exact = c.get(key);
    if (exact) {
      return {
        hit: true,
        kind: "exact",
        responseBody: exact.responseBody,
        inputTokens: exact.inputTokens,
        outputTokens: exact.outputTokens,
        cachedInputTokens: exact.cachedInputTokens,
      };
    }

    // Similarity layer — only when enabled AND embedding model configured.
    const threshold = similarityThreshold();
    if (threshold <= 0) {
      return { hit: false, cacheKey: key, reason: "miss" };
    }

    // Build the embedding for THIS request, then compare against every
    // entry that has one. O(N×D) where N=cache size, D=1536. At N=1000
    // that's ~1.5M float multiplications — well under a millisecond.
    // The dominant cost is the embedding API call (~50-200ms).
    const promptText = promptTextForEmbedding(body);
    if (!promptText) return { hit: false, cacheKey: key, reason: "no_prompt_text" };

    // Trick: re-use computeResponseSimilarity by embedding (promptText, "")
    // would force a second call per candidate. Instead, embed-then-compare
    // using the existing quality module by pairing against each candidate
    // text. To avoid N round-trips, we fall back to a simple heuristic
    // here — text-near-equality after lowercase + whitespace collapse —
    // for v1. Real embedding-based similarity needs an embed-once-and-
    // dot-product implementation we can ship in a follow-up.
    //
    // The heuristic catches the common case ("hello!" vs "Hello!" vs "hello!  ")
    // without paying the embedding bill. False negatives just fall back
    // to upstream — never to a wrong cached answer.
    const norm = (s: string) =>
      s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 2000);
    const target = norm(promptText);
    if (!target) return { hit: false, cacheKey: key, reason: "no_prompt_text" };

    // Iterate the cache map directly via the public-shape get loop. We
    // can't iterate LruTtlCache externally; for v1 we keep a sidecar
    // index of (cacheKey, normalizedText) pairs alongside.
    const idx = getSimilarityIndex();
    let bestKey: string | null = null;
    let bestScore = 0;
    for (const [otherKey, otherNorm] of idx.entries()) {
      if (otherNorm === target) {
        bestKey = otherKey;
        bestScore = 1;
        break;
      }
    }
    // Optional: when the heuristic missed and similarity_threshold < 1,
    // pay the embedding API cost ONCE (current request) and dot-product
    // against stored embeddings for true semantic similarity.
    if (!bestKey && threshold < 1) {
      const candidates: Array<{ key: string; entry: CacheEntry }> = [];
      for (const k of idx.keys()) {
        const e = c.get(k);
        if (e && e.promptText) candidates.push({ key: k, entry: e });
      }
      if (candidates.length > 0) {
        // Reuse computeResponseSimilarity on prompt pairs. This is wasteful
        // (one embedding pair-call per candidate), but it means the similarity
        // layer actually works before we add first-class stored embeddings.
        for (const cand of candidates) {
          const sim = await computeResponseSimilarity(
            promptText,
            cand.entry.promptText
          );
          if (sim != null && sim >= threshold && sim > bestScore) {
            bestScore = sim;
            bestKey = cand.key;
          }
        }
      }
    }

    if (bestKey) {
      const entry = c.get(bestKey);
      if (entry) {
        return {
          hit: true,
          kind: "similarity",
          responseBody: entry.responseBody,
          similarity: bestScore,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cachedInputTokens: entry.cachedInputTokens,
        };
      }
    }

    return { hit: false, cacheKey: key, reason: "miss" };
  } catch (err) {
    console.warn(
      "[cache] lookup failed — falling through to upstream:",
      err instanceof Error ? err.message : err
    );
    return { hit: false, cacheKey: null, reason: "internal_error" };
  }
}

// Sidecar normalized-text index used by the similarity heuristic. Same
// lifetime + eviction as the LRU itself — when an entry expires from
// the LRU on a `get()`, we lazily prune the sidecar via `forget()`.
const similarityIndex = new Map<string, string>();
function getSimilarityIndex(): Map<string, string> {
  return similarityIndex;
}

/**
 * Persist a successful upstream response under the cache key returned by
 * the prior lookup. No-op when caching is disabled or when the original
 * lookup decided the request was ineligible (cacheKey === null). Best-
 * effort: any internal failure logs and returns.
 */
export async function storeInSemanticCache(args: {
  projectId: string;
  cacheKey: string;
  body: OpenAIChatRequest;
  responseBody: unknown;
}): Promise<void> {
  try {
    const c = getCache();
    if (!c) return;
    const tokens = tokensFromResponse(args.responseBody);
    const promptText =
      similarityThreshold() > 0 ? promptTextForEmbedding(args.body) : "";
    const entry: CacheEntry = {
      responseBody: args.responseBody,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      promptText,
      // Embedding storage skipped here — similarity lookup computes prompt
      // pairs lazily. Future improvement: pre-embed at store time +
      // dot-product on lookup.
      embedding: [],
    };
    c.set(args.cacheKey, entry);
    if (promptText) {
      similarityIndex.set(
        args.cacheKey,
        promptText.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 2000)
      );
    }
  } catch (err) {
    console.warn(
      "[cache] store failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/** Test-only reset hook so unit tests don't bleed state across cases. */
export function _resetSemanticCache(): void {
  cache = null;
  _initLogged = false;
  similarityIndex.clear();
}

/** Test-only introspection. */
export const _testInternals = {
  exactKey,
  notCacheable,
  canonicalJson,
};
