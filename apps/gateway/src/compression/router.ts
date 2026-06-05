/**
 * ContentRouter — detect a shape, route to the right strategy, reassemble.
 *
 * `compressContent` / `compressMessages` keep the exact signatures +
 * behavior the original module exposed (keyed on `policy.enabled`), so
 * existing call sites and tests are unaffected. `compressContextMessages`
 * (M3) layers the off/audit/optimize mode on top.
 */

import type {
  ChatMessageLike,
  CompressedMessageInfo,
  CompressionMode,
  CompressionPolicy,
  CompressionResult,
  CompressionShape,
} from "./types";
import { detectShape } from "./detector";
import { smartCrushJson } from "./smart-crusher";
import {
  compressGitDiff,
  compressGitStatus,
  compressJsonLogs,
  compressShellListing,
  compressStackTrace,
  dedupeConsecutive,
  stripAnsi,
  truncateHeadTail,
} from "./text-shapes";

/**
 * Compress a raw content string in isolation. Exposed for tests + the
 * preview script.
 */
export function compressContent(
  content: string,
  policy: CompressionPolicy
): { content: string; shape: CompressionShape } {
  if (!policy.enabled) return { content, shape: "unknown" };
  if (content.length < policy.minMessageChars) {
    return { content, shape: "unknown" };
  }

  const shape = detectShape(content);

  // JSON containers route straight to the SmartCrusher. We deliberately
  // skip the line-oriented ansi/dedup pre-pass here — collapsing
  // "identical consecutive lines" inside pretty-printed JSON could corrupt
  // structure, and the crusher already produces compact valid JSON.
  if (shape === "json_array") {
    if (!policy.crushJson) return { content, shape };
    return { content: smartCrushJson(content, policy), shape };
  }

  let working = content;

  // Always-on stripping passes first (cheap, almost always safe).
  if (policy.stripAnsi) {
    working = stripAnsi(working);
  }
  if (policy.dedupeLines) {
    working = dedupeConsecutive(working);
  }

  switch (shape) {
    case "git_status":
      working = compressGitStatus(working);
      break;
    case "git_diff":
      working = compressGitDiff(working, policy.maxCompressedChars);
      break;
    case "shell_listing":
      working = compressShellListing(working, policy.maxCompressedChars);
      break;
    case "stack_trace":
      working = compressStackTrace(working, policy.maxCompressedChars);
      break;
    case "json_logs":
      working = compressJsonLogs(working, policy.maxCompressedChars);
      break;
    case "ansi_text":
    case "unknown":
      if (working.length > policy.maxCompressedChars * 2) {
        working = truncateHeadTail(working, policy.maxCompressedChars);
      }
      break;
    case "generic_long_log":
      working = truncateHeadTail(working, policy.maxCompressedChars);
      break;
  }

  return { content: working, shape };
}

/**
 * Compress every tool/function-result message in `messages`. Returns a
 * NEW array (input is not mutated). Non-tool messages are forwarded by
 * reference. When no rewrites happened, the input array reference is
 * returned unchanged.
 *
 * Keyed on `policy.enabled` — i.e. only does real work in optimize mode.
 * Use `compressContextMessages` for audit semantics.
 */
export function compressMessages(
  messages: ChatMessageLike[],
  policy: CompressionPolicy
): { messages: ChatMessageLike[]; result: CompressionResult } {
  const empty: CompressionResult = {
    applied: false,
    totalCharsSaved: 0,
    perMessage: [],
  };
  if (!policy.enabled) return { messages, result: empty };

  let totalSaved = 0;
  const perMessage: CompressedMessageInfo[] = [];
  let mutated = false;
  const out = messages.slice();

  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (!msg || (msg.role !== "tool" && msg.role !== "function")) continue;

    const toolName = typeof msg.name === "string" ? msg.name.toLowerCase() : null;
    if (toolName && policy.excludeToolNames.has(toolName)) continue;

    if (typeof msg.content !== "string") continue;
    const before = msg.content.length;
    if (before < policy.minMessageChars) continue;

    const { content: after, shape } = compressContent(msg.content, policy);
    if (after.length >= before) continue; // no gain — leave it
    out[i] = { ...msg, content: after };
    mutated = true;
    totalSaved += before - after.length;
    perMessage.push({
      index: i,
      role: msg.role,
      shape,
      charsBefore: before,
      charsAfter: after.length,
    });
  }

  if (!mutated) return { messages, result: empty };
  return {
    messages: out,
    result: { applied: true, totalCharsSaved: totalSaved, perMessage },
  };
}

/**
 * Mode-aware orchestration (M3) used by the request hot path.
 *
 *   - off:      passthrough, no work.
 *   - optimize: identical to `compressMessages` — rewrites the array.
 *   - audit:    measures potential savings against an `optimize`-shaped
 *               policy but RETURNS THE ORIGINAL MESSAGES. `applied` is
 *               false; `totalCharsSaved` / `perMessage` describe what
 *               WOULD have been saved so the caller can stamp a
 *               "potential savings" receipt without touching the prompt.
 */
export function compressContextMessages(
  messages: ChatMessageLike[],
  policy: CompressionPolicy,
  mode: CompressionMode
): { messages: ChatMessageLike[]; result: CompressionResult } {
  if (mode === "off") {
    return {
      messages,
      result: { applied: false, totalCharsSaved: 0, perMessage: [], mode: "off" },
    };
  }

  // Force a one-shot "optimize"-shaped policy so the underlying compressor
  // actually runs even when we're only auditing.
  const optimizePolicy: CompressionPolicy = { ...policy, enabled: true };
  const { messages: compressed, result } = compressMessages(messages, optimizePolicy);

  if (mode === "optimize") {
    return { messages: compressed, result: { ...result, mode: "optimize" } };
  }

  // audit: discard the rewritten array, keep the measurement.
  return {
    messages,
    result: {
      applied: false,
      totalCharsSaved: result.totalCharsSaved,
      perMessage: result.perMessage,
      mode: "audit",
    },
  };
}

/**
 * Token-savings estimate from char-savings. Conservative ~3.5 chars/token
 * ratio (tool output tokenizes denser than prose).
 */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.round(chars / 3.5);
}
