import type { ProviderConfig } from "../config";
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  ProxyResult,
  StreamFinal,
  StreamUpstream,
} from "./openai";
import { markRateLimited, pickKey } from "../key-rotator";

/**
 * Anthropic-side counterpart of providers/openai.ts authKeyFor + Retry-After
 * parser. Same semantics — see those for the design rationale. Duplicated
 * here (instead of a shared util) because the Anthropic header is `x-api-key`
 * and we want this file to remain a self-contained provider adapter.
 */
function anthropicAuthKey(provider: ProviderConfig): string {
  return pickKey(provider.name) ?? provider.apiKey;
}

function anthropicParseRetryAfterMs(headers: Headers): number | undefined {
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

/**
 * Native Anthropic provider — talks to `https://api.anthropic.com/v1/messages`
 * directly using the Messages API, NOT the OpenAI-compat shim. This is what
 * unlocks the prompt-cache discount: OpenAI-compat endpoints upstream of
 * Anthropic typically discard `cache_control` markers.
 *
 * From the gateway's POV the contract is identical to `openai.ts`:
 *
 *   - `callAnthropic(body, provider)` returns a `ProxyResult` whose `body` is
 *     already in OpenAI ChatCompletion shape, so `chat.ts` can log it with
 *     no special-casing.
 *   - `callAnthropicStream(body, provider)` returns a `ReadableStream` of
 *     OpenAI-style SSE chunks plus a `done` promise with the harvested usage.
 *
 * The conversion is intentionally narrow: only the fields agents actually use
 * (system / messages / tools / temperature / max_tokens / cache_control).
 * Less common knobs (top_k, stop_sequences) are forwarded as-is so the body
 * we send upstream is `{ ...openaiBody, ...overrides }`.
 */

const ANTHROPIC_VERSION = "2023-06-01";
// max_tokens is REQUIRED by the Anthropic API. OpenAI defaults it; we don't,
// so when callers omit it we send a sane ceiling instead of refusing the call.
const DEFAULT_MAX_TOKENS = 4096;

type CacheControl = { type: "ephemeral" };

type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: unknown;
  cache_control?: CacheControl;
};

type AnthropicRequest = {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
};

type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type AnthropicResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
};

// =========================================================================
// OpenAI → Anthropic request conversion
// =========================================================================

type OpenAIMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
      cache_control?: CacheControl;
      [k: string]: unknown;
    }>;

type OpenAIMessage = {
  role: string;
  content: OpenAIMessageContent | unknown;
  // OpenAI tool-call shape.
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

function normalizeContent(
  content: unknown
): string | AnthropicTextBlock[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out: AnthropicTextBlock[] = [];
    type Part = {
      type?: string;
      text?: string;
      cache_control?: CacheControl;
      [k: string]: unknown;
    };
    for (const part of content as Part[]) {
      if (!part || typeof part !== "object") continue;
      // Anthropic only natively supports text + image blocks. We keep text
      // and downgrade everything else to its JSON repr so nothing silently
      // disappears.
      if ((part as { type?: string }).type === "text" && typeof part.text === "string") {
        const block: AnthropicTextBlock = { type: "text", text: part.text };
        if (part.cache_control) block.cache_control = part.cache_control;
        out.push(block);
      } else if (typeof part.text === "string") {
        out.push({ type: "text", text: part.text });
      } else {
        out.push({ type: "text", text: JSON.stringify(part) });
      }
    }
    return out.length > 0 ? out : "";
  }
  if (content == null) return "";
  return String(content);
}

/**
 * Convert an OpenAI-style messages array into:
 *   - `system`: Anthropic's top-level system field (string OR text-blocks
 *     with cache_control preserved)
 *   - `messages`: Anthropic-compatible alternating user/assistant turns
 *
 * Special handling:
 *   - `role: "tool"` → wrapped as a `tool_result` content block on a `user`
 *     turn, matching Anthropic's tool-use protocol
 *   - assistant `tool_calls` → split into `tool_use` blocks
 *   - consecutive same-role turns are merged (Anthropic enforces strict
 *     alternation, which OpenAI does not)
 */
function convertMessages(messages: OpenAIMessage[]): {
  system: string | AnthropicTextBlock[] | undefined;
  messages: AnthropicMessage[];
} {
  let systemContent: string | AnthropicTextBlock[] | undefined;

  // Aggregate all system messages — agents sometimes split a system prompt
  // across multiple entries; Anthropic only takes one top-level system.
  const systemParts: AnthropicTextBlock[] = [];
  const nonSystem: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const c = normalizeContent(m.content);
      if (typeof c === "string") {
        if (c) systemParts.push({ type: "text", text: c });
      } else {
        systemParts.push(...c);
      }
    } else {
      nonSystem.push(m);
    }
  }
  if (systemParts.length === 1 && !systemParts[0].cache_control) {
    systemContent = systemParts[0].text;
  } else if (systemParts.length > 0) {
    systemContent = systemParts;
  }

  const out: AnthropicMessage[] = [];
  for (const m of nonSystem) {
    let role: "user" | "assistant";
    let content: string | AnthropicContentBlock[];

    if (m.role === "tool") {
      // Convert `{role: "tool", tool_call_id, content}` → user turn with
      // a tool_result block; Anthropic models this as the user reporting
      // the tool's output back into the conversation.
      role = "user";
      const toolText =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      content = [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id ?? "unknown",
          content: toolText,
        },
      ];
    } else if (m.role === "assistant") {
      role = "assistant";
      const blocks: AnthropicContentBlock[] = [];
      const text = normalizeContent(m.content);
      if (typeof text === "string" && text.length > 0) {
        blocks.push({ type: "text", text });
      } else if (Array.isArray(text)) {
        blocks.push(...text);
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try {
            input = tc.function.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch {
            input = { _raw: tc.function.arguments };
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      content = blocks.length > 0 ? blocks : "";
    } else {
      role = "user";
      content = normalizeContent(m.content);
    }

    // Anthropic requires strict alternation — merge consecutive same-role.
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      const prevArr = Array.isArray(prev.content)
        ? prev.content
        : prev.content
          ? ([{ type: "text", text: prev.content }] as AnthropicContentBlock[])
          : [];
      const nextArr = Array.isArray(content)
        ? content
        : content
          ? ([{ type: "text", text: content }] as AnthropicContentBlock[])
          : [];
      prev.content = [...prevArr, ...nextArr];
    } else {
      out.push({ role, content });
    }
  }

  return { system: systemContent, messages: out };
}

function convertTools(
  tools: unknown
): AnthropicTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: AnthropicTool[] = [];
  for (const t of tools as Array<{
    type?: string;
    function?: { name: string; description?: string; parameters?: unknown };
    name?: string;
    description?: string;
    input_schema?: unknown;
    cache_control?: CacheControl;
  }>) {
    // OpenAI shape: { type: "function", function: { name, description, parameters } }
    if (t.type === "function" && t.function) {
      const tool: AnthropicTool = {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      };
      if (t.cache_control) tool.cache_control = t.cache_control;
      out.push(tool);
      continue;
    }
    // Already-Anthropic shape: { name, description, input_schema, cache_control? }
    if (t.name && t.input_schema) {
      const tool: AnthropicTool = {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      };
      if (t.cache_control) tool.cache_control = t.cache_control;
      out.push(tool);
    }
  }
  return out.length > 0 ? out : undefined;
}

export function convertRequestToAnthropic(
  body: OpenAIChatRequest
): AnthropicRequest {
  const { system, messages } = convertMessages(
    Array.isArray(body.messages)
      ? (body.messages as unknown as OpenAIMessage[])
      : []
  );
  const tools = convertTools(body.tools);

  const req: AnthropicRequest = {
    model: String(body.model),
    max_tokens:
      typeof body.max_tokens === "number" && body.max_tokens > 0
        ? (body.max_tokens as number)
        : typeof body.max_completion_tokens === "number"
          ? (body.max_completion_tokens as number)
          : DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system != null) req.system = system;
  if (tools) req.tools = tools;
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;
  if (Array.isArray(body.stop)) req.stop_sequences = body.stop as string[];
  else if (typeof body.stop === "string") req.stop_sequences = [body.stop];
  if (body.stream === true) req.stream = true;
  if (typeof body.user === "string") req.metadata = { user_id: body.user };

  return req;
}

// =========================================================================
// Anthropic → OpenAI response conversion
// =========================================================================

function joinAnthropicText(content: AnthropicContentBlock[]): {
  text: string;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
} {
  let text = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  return { text, toolCalls };
}

function mapStopReason(stop: string | null): string {
  switch (stop) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return stop ?? "stop";
  }
}

export function convertResponseToOpenAI(
  resp: AnthropicResponse
): OpenAIChatResponse {
  const { text, toolCalls } = joinAnthropicText(resp.content);
  const cached = resp.usage.cache_read_input_tokens ?? 0;
  const inputTokens =
    resp.usage.input_tokens +
    cached +
    (resp.usage.cache_creation_input_tokens ?? 0);

  const message: OpenAIChatResponse["choices"][number]["message"] & {
    tool_calls?: typeof toolCalls;
  } = {
    role: "assistant",
    content: text,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(resp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: inputTokens + resp.usage.output_tokens,
      prompt_tokens_details: { cached_tokens: cached },
      cache_read_input_tokens: cached,
    },
  };
}

// =========================================================================
// Non-streaming
// =========================================================================

export async function callAnthropic(
  body: OpenAIChatRequest,
  provider: ProviderConfig
): Promise<ProxyResult> {
  const start = performance.now();
  const url = `${provider.baseUrl}/messages`;
  const anthropicBody = convertRequestToAnthropic(body);
  const key = anthropicAuthKey(provider);

  const upstreamRes = await fetch(url, {
    method: "POST",
    headers: anthropicHeaders(provider, key),
    body: JSON.stringify(anthropicBody),
  });

  if (upstreamRes.status === 429) {
    markRateLimited(provider.name, key, anthropicParseRetryAfterMs(upstreamRes.headers));
  }

  const upstreamLatencyMs = Math.round(performance.now() - start);
  const json = (await upstreamRes.json()) as AnthropicResponse | { type?: string; error?: { message: string } };

  if (!upstreamRes.ok || !("usage" in json) || !json.usage) {
    return {
      status: upstreamRes.status,
      // Pass the upstream error body straight through so the OpenAI client
      // sees a usable error shape.
      body:
        "error" in json && json.error
          ? { error: { message: json.error.message } }
          : ({ error: { message: `Anthropic HTTP ${upstreamRes.status}` } } as ProxyResult["body"]),
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      upstreamLatencyMs,
    };
  }

  const cached = json.usage.cache_read_input_tokens ?? 0;
  const inputTokens =
    json.usage.input_tokens + cached + (json.usage.cache_creation_input_tokens ?? 0);

  return {
    status: upstreamRes.status,
    body: convertResponseToOpenAI(json),
    inputTokens,
    outputTokens: json.usage.output_tokens,
    cachedInputTokens: cached,
    upstreamLatencyMs,
  };
}

// =========================================================================
// Streaming — Anthropic SSE → OpenAI ChatCompletion chunks
// =========================================================================

type AnthropicStreamEvent =
  | { type: "message_start"; message: { id: string; model: string; usage: AnthropicUsage } }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; partial_json?: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null; stop_sequence: string | null }; usage: { output_tokens: number } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

function anthropicHeaders(provider: ProviderConfig, key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

export async function callAnthropicStream(
  body: OpenAIChatRequest,
  provider: ProviderConfig
): Promise<StreamUpstream> {
  const start = performance.now();
  const url = `${provider.baseUrl}/messages`;
  const anthropicBody = convertRequestToAnthropic(body);
  anthropicBody.stream = true;
  const key = anthropicAuthKey(provider);

  const upstreamRes = await fetch(url, {
    method: "POST",
    headers: { ...anthropicHeaders(provider, key), Accept: "text/event-stream" },
    body: JSON.stringify(anthropicBody),
  });

  if (upstreamRes.status === 429) {
    markRateLimited(provider.name, key, anthropicParseRetryAfterMs(upstreamRes.headers));
  }

  const upstreamLatencyMs = Math.round(performance.now() - start);

  if (!upstreamRes.ok || !upstreamRes.body) {
    let errBody: unknown;
    try {
      errBody = await upstreamRes.json();
    } catch {
      errBody = { error: { message: `Anthropic HTTP ${upstreamRes.status}` } };
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

  const encoder = new TextEncoder();
  let messageId = "chatcmpl-anthropic";
  let model = String(body.model);
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let contentChars = 0;
  let finishReason: string | null = null;
  let errorMessage: string | null = null;
  let roleEmitted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const sendChunk = (delta: {
        role?: string;
        content?: string;
        tool_calls?: unknown;
      }, finish?: string | null, usage?: OpenAIChatResponse["usage"]) => {
        const chunk: {
          id: string;
          object: "chat.completion.chunk";
          created: number;
          model: string;
          choices: Array<{
            index: number;
            delta: typeof delta;
            finish_reason: string | null;
          }>;
          usage?: OpenAIChatResponse["usage"];
        } = {
          id: messageId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            { index: 0, delta, finish_reason: finish ?? null },
          ],
        };
        if (usage) chunk.usage = usage;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      };

      try {
        for (;;) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buf += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              let evt: AnthropicStreamEvent;
              try {
                evt = JSON.parse(payload);
              } catch {
                continue;
              }
              switch (evt.type) {
                case "message_start": {
                  messageId = evt.message.id;
                  model = evt.message.model;
                  inputTokens = evt.message.usage.input_tokens;
                  cachedInputTokens =
                    evt.message.usage.cache_read_input_tokens ?? 0;
                  // Add cache-creation tokens into the input bucket so cost
                  // math stays consistent with the non-streaming path.
                  inputTokens +=
                    cachedInputTokens +
                    (evt.message.usage.cache_creation_input_tokens ?? 0);
                  if (!roleEmitted) {
                    sendChunk({ role: "assistant", content: "" });
                    roleEmitted = true;
                  }
                  break;
                }
                case "content_block_delta": {
                  if (
                    evt.delta.type === "text_delta" &&
                    typeof evt.delta.text === "string"
                  ) {
                    contentChars += evt.delta.text.length;
                    if (!roleEmitted) {
                      sendChunk({ role: "assistant", content: "" });
                      roleEmitted = true;
                    }
                    sendChunk({ content: evt.delta.text });
                  }
                  break;
                }
                case "message_delta": {
                  finishReason = mapStopReason(evt.delta.stop_reason);
                  outputTokens = evt.usage.output_tokens;
                  break;
                }
                case "message_stop": {
                  const usage: OpenAIChatResponse["usage"] = {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                    prompt_tokens_details: { cached_tokens: cachedInputTokens },
                    cache_read_input_tokens: cachedInputTokens,
                  };
                  // Final OpenAI-style chunk with finish_reason + usage,
                  // followed by `[DONE]`.
                  sendChunk({}, finishReason ?? "stop", usage);
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  break;
                }
                case "error": {
                  errorMessage = evt.error?.message ?? "anthropic stream error";
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`
                    )
                  );
                  break;
                }
                // content_block_start / _stop / ping → noop downstream
              }
            }
          }
        }
      } catch (err) {
        errorMessage = errorMessage ?? (err as Error).message;
      } finally {
        controller.close();
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
    },
  });

  return { status: upstreamRes.status, stream, done };
}
