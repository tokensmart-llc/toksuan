import type { OpenAIChatRequest } from "./providers/openai";
import type { ProviderConfig } from "./config";

/**
 * Anthropic-style automatic prompt-cache breakpoint injection.
 *
 * Anthropic's prompt cache requires the caller to explicitly mark cache
 * boundaries with `cache_control: { type: "ephemeral" }` on the relevant
 * blocks. SDK users typically forget — the result is full-price billing on
 * every turn for an agent loop that should be 90% cheaper.
 *
 * What this function does, in order:
 *   1. Tag the system message (the largest, most-stable block in any agent
 *      stack) so reuse hits the cache.
 *   2. Tag the `tools` array — tool schemas are usually fixed for a session,
 *      and Anthropic charges full input rate for them every turn otherwise.
 *   3. Tag the SECOND-to-last user message — this lets the cache survive one
 *      more turn while leaving the most recent turn writable.
 *
 * Anthropic enforces a minimum cache-block size (1024 tokens for Sonnet,
 * 2048 for Haiku) — a tag on a tiny block is silently a no-op, not an error.
 * We use a permissive byte-length heuristic (~3 bytes/token average) and skip
 * tagging blocks that are obviously too small to qualify, so we don't churn
 * the request for nothing.
 *
 * MUTATES the body in place. Idempotent: re-running on an already-tagged
 * body is a no-op.
 */

const MIN_CACHEABLE_BYTES = 3500; // ~1100 tokens at ~3 bytes/tok

type CacheControl = { type: "ephemeral" };
type Block = {
  type: string;
  text?: string;
  cache_control?: CacheControl;
  [k: string]: unknown;
};
type Message = {
  role: string;
  content: string | Block[] | unknown;
  [k: string]: unknown;
};

function isAnthropicProvider(provider: ProviderConfig, model: string): boolean {
  if (provider.name === "anthropic") return true;
  // Some setups route Anthropic models through an OpenAI-compatible proxy
  // (Bedrock, Vertex, OpenRouter). Detect by the model-name prefix.
  return /^claude-/i.test(model);
}

function bytesOfContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content as Block[]) {
      if (typeof b?.text === "string") n += b.text.length;
    }
    return n;
  }
  return 0;
}

/**
 * Promote a string-content message to the rich block array form, returning
 * a reference to the array so callers can stamp `cache_control` on it.
 */
function ensureBlockArray(message: Message): Block[] {
  if (Array.isArray(message.content)) return message.content as Block[];
  if (typeof message.content === "string") {
    const blocks: Block[] = [{ type: "text", text: message.content }];
    message.content = blocks;
    return blocks;
  }
  // Unknown shape — wrap defensively so we never crash a real request.
  const blocks: Block[] = [{ type: "text", text: String(message.content ?? "") }];
  message.content = blocks;
  return blocks;
}

function tagLastBlock(blocks: Block[]): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b) continue;
    if (b.cache_control) return false; // already tagged — idempotent
    b.cache_control = { type: "ephemeral" };
    return true;
  }
  return false;
}

export type CacheInjection = {
  applied: boolean;
  taggedSystem: boolean;
  taggedTools: boolean;
  taggedHistory: boolean;
};

export function injectAnthropicCacheControl(
  body: OpenAIChatRequest,
  provider: ProviderConfig
): CacheInjection {
  const model = String(body.model ?? "");
  if (!isAnthropicProvider(provider, model)) {
    return { applied: false, taggedSystem: false, taggedTools: false, taggedHistory: false };
  }

  let taggedSystem = false;
  let taggedTools = false;
  let taggedHistory = false;

  const messages = Array.isArray(body.messages)
    ? (body.messages as Message[])
    : [];

  // 1) system message
  const sys = messages.find((m) => m.role === "system");
  if (sys && bytesOfContent(sys.content) >= MIN_CACHEABLE_BYTES) {
    const blocks = ensureBlockArray(sys);
    taggedSystem = tagLastBlock(blocks);
  }

  // 2) tools array — Anthropic accepts cache_control on the *last* tool
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const totalBytes = JSON.stringify(body.tools).length;
    if (totalBytes >= MIN_CACHEABLE_BYTES) {
      const lastTool = body.tools[body.tools.length - 1] as
        | { cache_control?: CacheControl }
        | undefined;
      if (lastTool && !lastTool.cache_control) {
        lastTool.cache_control = { type: "ephemeral" };
        taggedTools = true;
      }
    }
  }

  // 3) Conversation history: tag the second-most-recent user turn so the
  //    cache survives the next turn. Skipped for short conversations.
  const userTurns = messages
    .map((m, i) => ({ m, i }))
    .filter((x) => x.m.role === "user");
  if (userTurns.length >= 2) {
    const target = userTurns[userTurns.length - 2].m;
    if (bytesOfContent(target.content) >= MIN_CACHEABLE_BYTES) {
      const blocks = ensureBlockArray(target);
      taggedHistory = tagLastBlock(blocks);
    }
  }

  return {
    applied: taggedSystem || taggedTools || taggedHistory,
    taggedSystem,
    taggedTools,
    taggedHistory,
  };
}
