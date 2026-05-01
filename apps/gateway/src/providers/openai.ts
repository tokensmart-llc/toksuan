import type { ProviderConfig } from "../config";
import { markRateLimited, pickKey } from "../key-rotator";

/**
 * Resolve the auth key to use for this request:
 *   1. If the provider has a multi-key pool registered (via env comma-sep),
 *      pick the next available key — round-robin + cooldown-aware.
 *   2. Otherwise (BYO single key, or single-key env), use the config's key
 *      directly.
 *
 * Returns the chosen key. Caller passes it back to markRateLimited() if
 * the upstream returns 429 so we bench it for the cooldown window.
 */
function authKeyFor(provider: ProviderConfig): string {
  const fromPool = pickKey(provider.name);
  return fromPool ?? provider.apiKey;
}

/**
 * Parse a `Retry-After` header (per RFC 7231) into milliseconds. Returns
 * undefined if not present or unparseable. Most upstreams send seconds; some
 * send an HTTP-date.
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export type OpenAIChatRequest = {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  // Plus many optional fields — we forward whatever the user sent.
  [key: string]: unknown;
};

export type OpenAIChatResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    // OpenAI-compatible shape: { prompt_tokens_details: { cached_tokens } }
    prompt_tokens_details?: { cached_tokens?: number };
    // DeepSeek shape: { prompt_cache_hit_tokens, prompt_cache_miss_tokens }
    prompt_cache_hit_tokens?: number;
    // Anthropic-via-OpenAI-compat sometimes reports cache_read_input_tokens
    cache_read_input_tokens?: number;
  };
};

export type ProxyResult = {
  status: number;
  body: OpenAIChatResponse | { error: { message: string; type?: string } };
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  upstreamLatencyMs: number;
};

/**
 * Extract cached-input token count from an OpenAI-compatible `usage` object.
 * Different providers report the field under different names — we probe the
 * known ones and return 0 when nothing matches.
 */
function extractCachedTokens(usage: OpenAIChatResponse["usage"]): number {
  if (!usage) return 0;
  const fromDetails = usage.prompt_tokens_details?.cached_tokens;
  if (typeof fromDetails === "number" && fromDetails > 0) return fromDetails;
  if (typeof usage.prompt_cache_hit_tokens === "number")
    return usage.prompt_cache_hit_tokens;
  if (typeof usage.cache_read_input_tokens === "number")
    return usage.cache_read_input_tokens;
  return 0;
}

/**
 * Forward an OpenAI-compatible chat completion request to the given provider.
 * Returns the parsed response plus token counts and latency. The provider is
 * passed explicitly so the gateway can route different models to different
 * upstreams inside one request path.
 */
export async function callUpstream(
  body: OpenAIChatRequest,
  provider: ProviderConfig
): Promise<ProxyResult> {
  const start = performance.now();
  const url = `${provider.baseUrl}/chat/completions`;
  const key = authKeyFor(provider);

  const upstreamRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  // 429 from upstream → bench this key for the configured cooldown so the
  // next request rotates to a fresh one. The retry layer in chat.ts will
  // immediately re-invoke us, and pickKey() will return a different key.
  if (upstreamRes.status === 429) {
    markRateLimited(provider.name, key, parseRetryAfterMs(upstreamRes.headers));
  }

  const upstreamLatencyMs = Math.round(performance.now() - start);
  const json = (await upstreamRes.json()) as
    | OpenAIChatResponse
    | { error: { message: string } };

  if (!upstreamRes.ok || !("usage" in json) || !json.usage) {
    return {
      status: upstreamRes.status,
      body: json,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      upstreamLatencyMs,
    };
  }

  return {
    status: upstreamRes.status,
    body: json,
    inputTokens: json.usage.prompt_tokens,
    outputTokens: json.usage.completion_tokens,
    cachedInputTokens: extractCachedTokens(json.usage),
    upstreamLatencyMs,
  };
}

// =========================================================================
// Streaming (SSE)
// =========================================================================

export type StreamFinal = {
  status: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  upstreamLatencyMs: number;
  contentChars: number;
  finishReason: string | null;
  errorMessage: string | null;
};

export type StreamUpstream = {
  status: number;
  /** SSE stream to pipe straight back to the client. */
  stream: ReadableStream<Uint8Array>;
  /** Resolves once the upstream stream has fully drained. */
  done: Promise<StreamFinal>;
  /**
   * v0.6.7 — when `status` is non-2xx the upstream returned a JSON
   * error body (NOT an SSE stream). We parse it here so the chat
   * handler can decide whether to auto-fallback to the caller's
   * original model (rewrite-failure detection in
   * `failover.isRewriteFailure4xx`). Undefined for 2xx responses
   * because the body is in the SSE stream, which we never block on.
   */
  errorBody?: unknown;
};

/**
 * Streaming variant of `callUpstream`. Returns a passthrough `ReadableStream`
 * that forwards upstream SSE chunks unmodified to the client AND a `done`
 * promise that resolves once the stream finishes with the accumulated usage
 * counters parsed out of the stream.
 *
 * To make billing reliable we automatically request `stream_options:
 * include_usage` if the caller didn't already. Most OpenAI-compatible
 * providers (OpenAI, DeepSeek, Qwen) honor this and emit a final
 * chunk containing `usage`. Doubao and a few smaller providers ignore it,
 * in which case we charge $0 and log the row with usage=0 — we never want
 * to bill phantom tokens from a heuristic estimate.
 */
export async function callUpstreamStream(
  body: OpenAIChatRequest,
  provider: ProviderConfig
): Promise<StreamUpstream> {
  const start = performance.now();

  const requestBody: OpenAIChatRequest = { ...body };
  const existingOpts = (requestBody as { stream_options?: unknown })
    .stream_options;
  if (
    existingOpts == null ||
    (typeof existingOpts === "object" &&
      !("include_usage" in (existingOpts as object)))
  ) {
    (requestBody as { stream_options?: unknown }).stream_options = {
      ...(typeof existingOpts === "object" && existingOpts ? existingOpts : {}),
      include_usage: true,
    };
  }

  const url = `${provider.baseUrl}/chat/completions`;
  const key = authKeyFor(provider);
  const upstreamRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(requestBody),
  });

  if (upstreamRes.status === 429) {
    markRateLimited(provider.name, key, parseRetryAfterMs(upstreamRes.headers));
  }

  const upstreamLatencyMs = Math.round(performance.now() - start);

  // Non-2xx → upstream returned an error body, NOT an SSE stream. Fall back
  // to read the JSON error and emit it as a single SSE error event so the
  // client gets a useful payload either way.
  if (!upstreamRes.ok || !upstreamRes.body) {
    let errBody: unknown;
    try {
      errBody = await upstreamRes.json();
    } catch {
      errBody = { error: { message: `Upstream HTTP ${upstreamRes.status}` } };
    }
    const text =
      `data: ${JSON.stringify(errBody)}\n\n` +
      `data: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return {
      status: upstreamRes.status,
      stream,
      errorBody: errBody,
      done: Promise.resolve({
        status: upstreamRes.status,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        upstreamLatencyMs,
        contentChars: 0,
        finishReason: null,
        errorMessage:
          typeof errBody === "object" &&
          errBody &&
          "error" in errBody &&
          typeof (errBody as { error?: { message?: unknown } }).error
            ?.message === "string"
            ? (errBody as { error: { message: string } }).error.message
            : `HTTP ${upstreamRes.status}`,
      }),
    };
  }

  let resolveDone!: (final: StreamFinal) => void;
  const done = new Promise<StreamFinal>((resolve) => {
    resolveDone = resolve;
  });

  // Tee the upstream byte stream: one branch goes to the client untouched,
  // the other branch we parse line-by-line to harvest `usage` + content len.
  const [forClient, forParse] = upstreamRes.body.tee();

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let contentChars = 0;
  let finishReason: string | null = null;
  let errorMessage: string | null = null;

  (async () => {
    const reader = forParse.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });

        // SSE messages are separated by blank lines. Process whole frames.
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: { content?: unknown };
                  finish_reason?: string | null;
                }>;
                usage?: OpenAIChatResponse["usage"];
                error?: { message?: string };
              };
              if (obj.usage) {
                inputTokens = obj.usage.prompt_tokens ?? inputTokens;
                outputTokens = obj.usage.completion_tokens ?? outputTokens;
                cachedInputTokens =
                  extractCachedTokens(obj.usage) || cachedInputTokens;
              }
              if (obj.choices && obj.choices.length > 0) {
                const ch = obj.choices[0];
                if (typeof ch.delta?.content === "string") {
                  contentChars += ch.delta.content.length;
                }
                if (ch.finish_reason) finishReason = ch.finish_reason;
              }
              if (obj.error?.message) errorMessage = obj.error.message;
            } catch {
              // Non-JSON keepalive lines — ignore.
            }
          }
        }
      }
    } catch (err) {
      errorMessage = errorMessage ?? (err as Error).message;
    } finally {
      resolveDone({
        status: upstreamRes.status,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        upstreamLatencyMs,
        contentChars,
        finishReason,
        errorMessage,
      });
    }
  })();

  return { status: upstreamRes.status, stream: forClient, done };
}
