/**
 * Embedding-based response similarity for shadow A/B trials.
 *
 * Goal: take the Quality Proof card from "shadow returned 2xx" (a coarse
 * signal — a non-200 doesn't crash but might still be garbage content) to
 * "shadow output is semantically close to primary output" — a real quality
 * signal that customers can defend in front of their PM.
 *
 * Algorithm: text-embed both responses with the same embedding model,
 * cosine-similarity the vectors. Range [-1, 1]; for chat-style outputs
 * the typical range is roughly:
 *   - 0.95+ : almost certainly equivalent
 *   - 0.85–0.95: same answer worded differently
 *   - 0.70–0.85: same topic, possibly different conclusion
 *   - <0.70: meaningfully different — investigate before switching primary
 *
 * Configuration:
 *   TOKENSMART_QUALITY_EMBED_MODEL=text-embedding-3-small
 *     # the embedding model to use. text-embedding-3-small is a great
 *     # default — 1536 dim, $0.02/1M tokens, OpenAI. Other supported:
 *     # text-embedding-3-large, text-embedding-ada-002.
 *   TOKENSMART_QUALITY_EMBED_PROVIDER=openai
 *     # which provider to ROUTE the embed call to. The credential resolution
 *     # uses the env-configured key for that provider; we deliberately do
 *     # NOT use BYO keys here because embedding traffic for quality eval
 *     # shouldn't bill against the customer's quota.
 *   TOKENSMART_QUALITY_EMBED_BASE_URL=https://api.openai.com/v1
 *     # base URL override
 *
 * Best-effort + isolated: any failure in this module returns null and
 * logs a single warning. The shadow call's primary outcome is unaffected.
 *
 * Cost: ~$0.0002 per shadow trial at $0.02/M for ~1000 char responses.
 * For most projects this is negligible (1000 trials/month = $0.20).
 */

const MAX_INPUT_CHARS = 8000;

let _disabledLogged = false;

function getEmbedConfig(): {
  model: string;
  baseUrl: string;
  apiKey: string;
} | null {
  const model = process.env.TOKENSMART_QUALITY_EMBED_MODEL;
  if (!model) {
    if (!_disabledLogged) {
      _disabledLogged = true;
      console.log(
        "[quality] embedding similarity DISABLED (set TOKENSMART_QUALITY_EMBED_MODEL to enable)"
      );
    }
    return null;
  }
  const provider = (
    process.env.TOKENSMART_QUALITY_EMBED_PROVIDER ?? "openai"
  ).toLowerCase();
  const baseUrl =
    process.env.TOKENSMART_QUALITY_EMBED_BASE_URL ??
    (provider === "openai" ? "https://api.openai.com/v1" : "");
  if (!baseUrl) {
    console.warn(
      `[quality] no base URL for embedding provider '${provider}' — disabling`
    );
    return null;
  }
  // Resolve the API key from the standard provider env var.
  const envKeyName =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : `${provider.toUpperCase()}_API_KEY`;
  const apiKey = process.env[envKeyName];
  if (!apiKey) {
    console.warn(
      `[quality] no ${envKeyName} for embedding provider '${provider}' — disabling`
    );
    return null;
  }
  // Use the FIRST key if it's a comma-separated multi-key value (we don't
  // wire the rotator here — embeddings are cheap and infrequent).
  const firstKey = apiKey.split(",")[0].trim();
  return { model, baseUrl, apiKey: firstKey };
}

/**
 * Extract the model's textual response from an OpenAI ChatCompletion-shaped
 * body. Returns "" when the body has no extractable content (errors,
 * unparseable shapes, tool-only responses).
 */
export function extractResponseText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const obj = body as {
    choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>;
    streamed?: boolean;
    content_chars?: number;
  };
  // Streamed responses store a summary, not the full text — we have nothing
  // to embed in that case. (A future iteration could buffer the streamed
  // content alongside `content_chars`.)
  if (obj.streamed) return "";
  const ch = obj.choices?.[0];
  if (!ch) return "";
  const c = ch.message?.content ?? ch.delta?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    // Vision/multi-part content — concatenate text parts.
    return c
      .map((p) =>
        p && typeof p === "object" && "text" in p && typeof (p as { text: unknown }).text === "string"
          ? ((p as { text: string }).text)
          : ""
      )
      .join("\n");
  }
  return "";
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Embed one or more strings in a single OpenAI-compatible batch call.
 * Returns null on any failure mode (no config, network error, malformed
 * response).
 *
 * INDEX ALIGNMENT CONTRACT: the returned array is 1:1 with `texts` —
 * `result[i]` is the embedding of `texts[i]`. Empty/whitespace-only inputs
 * are NOT sent to the API (they have no meaningful embedding) and come back
 * as an empty `[]` placeholder so callers can keep indexing by position
 * without silently shifting. Returns null only when there is nothing
 * embeddable at all OR the upstream call/response failed.
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const truncated = texts.map((t) => t.slice(0, MAX_INPUT_CHARS));
  // Indices we actually send to the API. Skip empty / whitespace-only inputs:
  // they have no meaningful embedding and some providers reject blank input.
  const sendIndices: number[] = [];
  const toSend: string[] = [];
  truncated.forEach((t, i) => {
    if (t.trim().length > 0) {
      sendIndices.push(i);
      toSend.push(t);
    }
  });
  if (toSend.length === 0) return null;

  const cfg = getEmbedConfig();
  if (!cfg) return null;

  try {
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: toSend }),
    });
    if (!res.ok) {
      console.warn(`[quality] embed HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const returned = json.data?.map((d) => d.embedding).filter((v): v is number[] =>
      Array.isArray(v)
    );
    if (!returned || returned.length !== toSend.length) {
      console.warn("[quality] embed response missing embeddings");
      return null;
    }
    // Re-expand to the original positions: empty inputs become `[]`.
    const aligned: number[][] = texts.map(() => []);
    sendIndices.forEach((originalIndex, k) => {
      aligned[originalIndex] = returned[k];
    });
    return aligned;
  } catch (err) {
    console.warn(
      "[quality] embed call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Embed two strings in a single OpenAI-compat batch call and return the
 * cosine similarity. Returns null on any failure mode (no config, empty
 * input, network error, malformed response).
 */
export async function computeResponseSimilarity(
  primaryText: string,
  shadowText: string
): Promise<number | null> {
  if (!primaryText || !shadowText) return null;
  if (primaryText === shadowText) return 1.0; // skip the API call

  const embeddings = await embedTexts([primaryText, shadowText]);
  const a = embeddings?.[0];
  const b = embeddings?.[1];
  if (!a || !b) return null;
  const sim = cosineSimilarity(a, b);
  // Clamp to [-1, 1] to satisfy the DB CHECK constraint even in the face
  // of floating-point edge cases.
  return Math.max(-1, Math.min(1, sim));
}

/** Test-only export. */
export const _testInternals = { cosineSimilarity };
