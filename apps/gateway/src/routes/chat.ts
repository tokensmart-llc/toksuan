import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  findApiKey,
  getProjectPlan,
  insertRequest,
  recordModelRejection,
  releasePlanReservations,
  reservePlanForRequest,
  touchApiKey,
  type InsertRequest,
} from "../db";
import { resolveProvider } from "../provider-resolve";
import {
  callUpstream,
  callUpstreamStream,
  type OpenAIChatRequest,
} from "../providers/openai";
import {
  callAnthropic,
  callAnthropicStream,
} from "../providers/anthropic";
import {
  calcCacheSavingsMicroCents,
  calcCostMicroCents,
  calcRoutingSavingMicroCents,
  microCentsToCents,
} from "../pricing";
import {
  checkAndReserveBudget,
  estimateChatCostMicroCents,
  releaseBudgetReservations,
} from "../budget";
import { env, findProviderTemplate, type ProviderConfig } from "../config";
import type { Provider, ProviderName } from "../pricing";
import { isBuiltInProvider } from "../pricing";
import { fingerprintRequest } from "../fingerprint";
import { loopDetector, recordDurableLoopAndCheck } from "../loop-detector";
import { applyRouting, applyBaselineRouting } from "../router";
import { dispatchAlert } from "../alerts";
import { limitsForPlan } from "../plans";
import { injectAnthropicCacheControl } from "../cache-control";
import { dispatchShadow } from "../shadow";
import {
  lookupSemanticCache,
  storeInSemanticCache,
} from "../semantic-cache";
import { parseAttributionHeaders } from "../tags";
import {
  applyTemplateToBody,
  loadTemplate,
  parseTemplateRef,
  parseTemplateVarsHeader,
  renderTemplate,
} from "../templates";
import {
  backoffDelayMs,
  getRetryBaseDelayMs,
  getRetryMaxAttempts,
  isRetryableError,
  isRetryableStatus,
  isRewriteFailure4xx,
  lookupFailover,
  rewriteFallbackEnabled,
  sleep,
} from "../failover";
import { newSpanId, newTraceId, recordSpan } from "../otel";
import {
  buildPolicyFromEnv as buildToolCompressPolicy,
  compressContextMessages,
  estimateTokensFromChars as estimateCompressedTokens,
  resolveRequestMode,
  type CompressionPolicy as ToolCompressPolicy,
} from "../compression";
import { storeCompressedBlobs } from "../compression/store";

// Built once at boot from process.env. The compressor is a pure module
// so re-deriving the policy per request would just be wasted work — env
// is static for the lifetime of the gateway process. Tests that need
// a different policy override it directly via dependency injection in
// the compressor's own test file.
const TOOL_COMPRESS_POLICY: ToolCompressPolicy = buildToolCompressPolicy(process.env);

/**
 * Stamp `tool_compress_micro_cents_saved_est` on the tags map once the
 * effective provider+model is known, by repricing the estimated saved
 * input tokens at the model that actually ran. We can't do this when
 * the compressor itself runs because routing might still swap the
 * model, and the per-token rate varies by an order of magnitude
 * between gpt-5.5 and deepseek-chat — pricing too early would over- or
 * under-claim the savings. Cheap (table lookup + multiply) so we run
 * it on the success path of every code branch.
 *
 * Tag is a string because the request row's `tags` column is JSONB-
 * of-strings; the dashboard's getSavingsBreakdown coerces back via
 * (tags->>'tool_compress_micro_cents_saved_est')::bigint.
 */
function stampToolCompressMicroCentsSaved(
  tags: Record<string, string>,
  provider: ProviderName,
  model: string
): void {
  if (tags.tool_compress_applied !== "1") return;
  const tokensSaved = Number(tags.tool_compress_tokens_saved_est ?? "0");
  if (!Number.isFinite(tokensSaved) || tokensSaved <= 0) return;
  // Re-use the cost calculator with output_tokens=0 so the result is
  // strictly the input-side savings — that's the dimension we
  // actually compressed. Cached-input is also 0 because the
  // compressor strips bytes from the OUTBOUND request; cache-hit
  // accounting is a separate dimension billed by the upstream after
  // its own prompt-cache lookup.
  const microCents = calcCostMicroCents(provider, model, tokensSaved, 0, 0);
  if (microCents > 0) {
    tags.tool_compress_micro_cents_saved_est = String(microCents);
  }
}

// =========================================================================
// Caller-visible routing decision response headers (v0.6.7)
// =========================================================================
//
// TokSuan's product thesis ("caller doesn't change strings, gateway saves
// money in the background") is intentionally invisible to application code.
// Operators still need same-trip proof when testing an agent harness against
// the gateway. Most OpenAI-SDK callers don't auto-expose the response body's
// `model` field, so even the post-hoc proof of "we routed a frontier model →
// a cheaper flash-class model" is otherwise hidden.
//
// Headers stamped on every chat-completions response (success, error,
// blocked — every terminal path):
//   - X-Tokensmart-Asked-Model            the model the caller passed in
//   - X-Tokensmart-Landed-Model           the model that actually ran
//                                         (post-routing AND post-failover);
//                                         on a streaming response this is
//                                         the post-routing model — the SSE
//                                         headers leave BEFORE failover can
//                                         re-route, so failover swaps in
//                                         the streaming branch are not
//                                         observable via this header
//                                         (the request row's `model`
//                                         column captures the truth and
//                                         operators look it up via the
//                                         X-Tokensmart-Request-Id link)
//   - X-Tokensmart-Routing-Reason         the same string written into
//                                         requests.routing_reason (no
//                                         routing → "none")
//   - X-Tokensmart-Cost-Cents             final cost in cents (6 decimals
//                                         to preserve sub-cent precision);
//                                         OMITTED on the streaming success
//                                         path because we don't know the
//                                         token counts when the SSE headers
//                                         flush — operators read it from
//                                         the request row instead
//   - X-Tokensmart-Cost-Saved-Vs-Asked-Cents
//                                         routing_saving in cents — what
//                                         this request would have cost on
//                                         the originally-asked model minus
//                                         what it actually cost; 0 when
//                                         routing was a no-op
//
// Operators who want the visibility wire their tooling to read the headers;
// default callers continue to see the plain OpenAI-compat response body
// unchanged.

type RoutingHeaderInfo = {
  askedModel: string;
  landedModel: string;
  routingReason: string | null;
  costMicroCents?: number;
  costSavedVsAskedMicroCents?: number;
  /**
   * Estimated input chars dropped by the tool-result compressor on this
   * request. Surfaced as `X-Tokensmart-Tool-Compress-Chars-Saved` so an
   * operator A/B-testing the feature can observe the per-request payoff
   * without grepping the dashboard. 0 / undefined when the compressor
   * didn't fire (master switch off, no eligible tool messages, or the
   * caller sent x-ts-tool-compress: off).
   */
  toolCompressCharsSaved?: number;
  /**
   * Same as toolCompressCharsSaved but priced in micro_cents at the
   * model that actually executed. 6 decimals preserve sub-cent
   * precision. Optional (may be absent on streaming responses, where
   * the model may swap during failover after headers flush).
   */
  toolCompressMicroCentsSaved?: number;
};

function sanitizeHeaderValue(s: string): string {
  // Baseline routing reasons embed a Unicode arrow ("→") which strict
  // HTTP/1.1 parsers reject in header values. Replace with the ASCII
  // equivalent + drop any control bytes + clamp length so a future
  // diagnostic string explosion can't blow up a header line.
  return s.replace(/→/g, "->").replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 512);
}

function formatCentsFromMicro(microCents: number): string {
  // 1 cent = 1000 micro_cents; 6 decimals preserves all sub-cent precision
  // we have on hand (input is integer micro_cents).
  return (microCents / 1000).toFixed(6);
}

export function buildRoutingDecisionHeaders(
  info: RoutingHeaderInfo
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Tokensmart-Asked-Model": sanitizeHeaderValue(info.askedModel),
    "X-Tokensmart-Landed-Model": sanitizeHeaderValue(info.landedModel),
    "X-Tokensmart-Routing-Reason": sanitizeHeaderValue(
      info.routingReason ?? "none"
    ),
  };
  if (info.costMicroCents !== undefined) {
    headers["X-Tokensmart-Cost-Cents"] = formatCentsFromMicro(
      info.costMicroCents
    );
  }
  if (info.costSavedVsAskedMicroCents !== undefined) {
    headers["X-Tokensmart-Cost-Saved-Vs-Asked-Cents"] = formatCentsFromMicro(
      info.costSavedVsAskedMicroCents
    );
  }
  if (info.toolCompressCharsSaved !== undefined && info.toolCompressCharsSaved > 0) {
    headers["X-Tokensmart-Tool-Compress-Chars-Saved"] = String(
      info.toolCompressCharsSaved
    );
  }
  if (
    info.toolCompressMicroCentsSaved !== undefined &&
    info.toolCompressMicroCentsSaved > 0
  ) {
    headers["X-Tokensmart-Tool-Compress-Saved-Cents"] = formatCentsFromMicro(
      info.toolCompressMicroCentsSaved
    );
  }
  return headers;
}

/**
 * Read the compressor breadcrumbs that the request handler stamped onto
 * `tags` and turn them back into a partial RoutingHeaderInfo for the
 * response-header builder. Tags are strings (the column is JSONB-of-
 * strings) so the header builder can't read them directly without
 * coercion. Unknown / missing values fall through to undefined →
 * header omitted. The return shape is keyed to the
 * `toolCompress{Chars,MicroCents}Saved` fields of RoutingHeaderInfo
 * so callers can spread it directly.
 */
function readToolCompressFromTags(
  tags: Record<string, string>
): {
  toolCompressCharsSaved: number | undefined;
  toolCompressMicroCentsSaved: number | undefined;
} {
  if (tags.tool_compress_applied !== "1") {
    return {
      toolCompressCharsSaved: undefined,
      toolCompressMicroCentsSaved: undefined,
    };
  }
  const charsRaw = Number(tags.tool_compress_chars_saved ?? "");
  const mcRaw = Number(tags.tool_compress_micro_cents_saved_est ?? "");
  return {
    toolCompressCharsSaved:
      Number.isFinite(charsRaw) && charsRaw > 0 ? charsRaw : undefined,
    toolCompressMicroCentsSaved:
      Number.isFinite(mcRaw) && mcRaw > 0 ? mcRaw : undefined,
  };
}

function applyRoutingDecisionHeaders(
  c: { header: (name: string, value: string) => void },
  info: RoutingHeaderInfo
): void {
  for (const [name, value] of Object.entries(buildRoutingDecisionHeaders(info))) {
    c.header(name, value);
  }
}

function toolNameFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name === "string" && obj.name.trim()) return obj.name.trim();
  const fn = obj.function;
  if (fn && typeof fn === "object") {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

function summarizeToolNames(values: unknown[]): string | null {
  const seen: string[] = [];
  for (const value of values) {
    const name = toolNameFromUnknown(value);
    if (!name || seen.includes(name)) continue;
    seen.push(name.slice(0, 64));
    if (seen.length >= 8) break;
  }
  return seen.length > 0 ? seen.join(",") : null;
}

function stampDeclaredToolTags(
  tags: Record<string, string>,
  body: OpenAIChatRequest
): void {
  // These tags are for operator visibility and cost debugging only. `tags`
  // also contains user-supplied x-ts-tag values, so no security/enforcement
  // path may treat tool_* tags as trusted facts.
  if (!Array.isArray(body.tools) || body.tools.length === 0) return;
  tags.tools_declared_count = String(body.tools.length);
  const names = summarizeToolNames(body.tools);
  if (names) tags.tools_declared_names = names;
}

function extractResponseToolCalls(responseBody: unknown): unknown[] {
  if (!responseBody || typeof responseBody !== "object") return [];
  const choices = (responseBody as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];

  const calls: unknown[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls)) calls.push(...toolCalls);
  }
  return calls;
}

function stampResponseToolCallTags(
  tags: Record<string, string>,
  responseBody: unknown,
  source: string
): void {
  const calls = extractResponseToolCalls(responseBody);
  if (calls.length === 0) return;
  tags.tool_calls_observed = source;
  tags.tool_call_count = String(calls.length);
  const names = summarizeToolNames(calls);
  if (names) tags.tool_call_names = names;
}

/**
 * Provider dispatcher. Returns the correct callUpstream variant for the
 * given provider — Anthropic has its own native /v1/messages adapter, every
 * other provider speaks OpenAI-compat chat completions.
 */
function callForProvider(
  providerCfg: ProviderConfig
): (
  body: OpenAIChatRequest,
  p: ProviderConfig
) => ReturnType<typeof callUpstream> {
  return providerCfg.name === "anthropic" ? callAnthropic : callUpstream;
}

function streamCallForProvider(
  providerCfg: ProviderConfig
): (
  body: OpenAIChatRequest,
  p: ProviderConfig
) => ReturnType<typeof callUpstreamStream> {
  return providerCfg.name === "anthropic" ? callAnthropicStream : callUpstreamStream;
}

// =========================================================================
// Retry + cross-provider failover (shared by stream and non-stream paths)
// =========================================================================

type AttemptOk = {
  ok: true;
  result: Awaited<ReturnType<typeof callUpstream>>;
  /** Final provider used after any failover. */
  lastProvider: ProviderName;
  /** Final model used after any failover. */
  lastModel: string;
  attempts: number;
};

type AttemptErr = {
  ok: false;
  error: string;
  lastProvider: ProviderName;
  lastModel: string;
  attempts: number;
};

/**
 * Wrap a non-streaming upstream call with:
 *   1. up to N retries on transient errors (5xx / 408 / 429 / network)
 *      against the SAME provider+model
 *   2. a single cross-provider failover attempt to the model in
 *      TOKENSMART_FAILOVER_MAP if all retries against the original failed
 *
 * Mutates `body.model` ONLY when failover swaps the model — caller must read
 * the returned `lastModel` to know what actually executed.
 */
async function callWithRetryAndFailover(opts: {
  body: OpenAIChatRequest;
  providerCfg: ProviderConfig;
  provider: string;
  userId: string | null;
}): Promise<AttemptOk | AttemptErr> {
  const maxAttempts = getRetryMaxAttempts();
  const baseDelay = getRetryBaseDelayMs();
  const totalAttempts = maxAttempts + 1;

  // Phase 1: retry on the original provider/model.
  const phase1 = await tryUpstreamWithRetries({
    body: opts.body,
    providerCfg: opts.providerCfg,
    totalAttempts,
    baseDelay,
  });
  if (phase1.ok) {
    return {
      ok: true,
      result: phase1.result,
      lastProvider: opts.providerCfg.name,
      lastModel: opts.body.model,
      attempts: phase1.attempts,
    };
  }

  // Phase 2: cross-provider failover, if a mapping exists.
  const failoverModel = lookupFailover(opts.body.model);
  if (!failoverModel) {
    return {
      ok: false,
      error: phase1.error,
      lastProvider: opts.providerCfg.name,
      lastModel: opts.body.model,
      attempts: phase1.attempts,
    };
  }

  // Resolve the failover provider — may be a different provider entirely
  // (e.g. gpt-4o → claude-3-5-sonnet). Honor BYO keys for that provider too.
  const resolved = await resolveProvider(opts.userId, failoverModel);
  if (!resolved.ok) {
    console.warn(
      `[tokensmart] failover ${opts.body.model}→${failoverModel} skipped: ${resolved.reason} (${resolved.providerName ?? "no provider"})`
    );
    return {
      ok: false,
      error: phase1.error,
      lastProvider: opts.providerCfg.name,
      lastModel: opts.body.model,
      attempts: phase1.attempts,
    };
  }

  console.warn(
    `[tokensmart] failover ${opts.body.model}→${failoverModel} (${opts.providerCfg.name}→${resolved.config.name}) after ${phase1.attempts} failed attempt(s): ${phase1.error}`
  );

  const failoverBody: OpenAIChatRequest = { ...opts.body, model: failoverModel };
  const phase2 = await tryUpstreamWithRetries({
    body: failoverBody,
    providerCfg: resolved.config,
    totalAttempts,
    baseDelay,
  });
  if (phase2.ok) {
    return {
      ok: true,
      result: phase2.result,
      lastProvider: resolved.config.name,
      lastModel: failoverModel,
      attempts: phase1.attempts + phase2.attempts,
    };
  }
  return {
    ok: false,
    error: `${phase1.error} | failover (${failoverModel}): ${phase2.error}`,
    lastProvider: resolved.config.name,
    lastModel: failoverModel,
    attempts: phase1.attempts + phase2.attempts,
  };
}

export async function tryUpstreamWithRetries(opts: {
  body: OpenAIChatRequest;
  providerCfg: ProviderConfig;
  totalAttempts: number;
  baseDelay: number;
}): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof callUpstream>>; attempts: number }
  | { ok: false; error: string; attempts: number }
> {
  const call = callForProvider(opts.providerCfg);
  let lastErr: string = "no attempts made";
  for (let attempt = 0; attempt < opts.totalAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelayMs(attempt - 1, opts.baseDelay));
    }
    try {
      const result = await call(opts.body, opts.providerCfg);
      // 2xx (or any status that isn't classified as retryable) → success path.
      if (!isRetryableStatus(result.status)) {
        return { ok: true, result, attempts: attempt + 1 };
      }
      // Retryable status — fall through to next iteration unless we're out
      // of attempts, in which case report failure so the caller can enter
      // cross-provider failover instead of logging the final 5xx/429 as a
      // completed upstream attempt.
      lastErr = `HTTP ${result.status}`;
      if (attempt + 1 >= opts.totalAttempts) {
        return { ok: false, error: lastErr, attempts: attempt + 1 };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (!isRetryableError(err)) {
        return { ok: false, error: lastErr, attempts: attempt + 1 };
      }
      // retry
    }
  }
  return { ok: false, error: lastErr, attempts: opts.totalAttempts };
}

type StreamAttemptOk = {
  ok: true;
  upstream: Awaited<ReturnType<typeof callUpstreamStream>>;
  lastProvider: ProviderName;
  lastModel: string;
  attempts: number;
};
type StreamAttemptErr = {
  ok: false;
  error: string;
  lastProvider: ProviderName;
  lastModel: string;
  attempts: number;
};

/**
 * Streaming variant. We can only retry on the INITIAL connect — once the
 * upstream starts emitting SSE bytes, the client may already have received
 * partial output and silently retrying would be observably wrong.
 *
 * Initial-connect failures are detected by:
 *   - The stream call throws (network exception)
 *   - `upstream.status` is non-2xx with no body bytes (the openai.ts
 *     adapter already converts this into a single-frame SSE error and
 *     populates `done.errorMessage` synchronously via the resolved promise
 *     in that branch — we use `status` as the trigger here)
 */
async function callStreamWithRetryAndFailover(opts: {
  body: OpenAIChatRequest;
  providerCfg: ProviderConfig;
  provider: string;
  userId: string | null;
}): Promise<StreamAttemptOk | StreamAttemptErr> {
  const maxAttempts = getRetryMaxAttempts();
  const baseDelay = getRetryBaseDelayMs();
  const totalAttempts = maxAttempts + 1;

  const phase1 = await tryUpstreamStreamWithRetries({
    body: opts.body,
    providerCfg: opts.providerCfg,
    totalAttempts,
    baseDelay,
  });
  if (phase1.ok) {
    return {
      ok: true,
      upstream: phase1.upstream,
      lastProvider: opts.providerCfg.name,
      lastModel: opts.body.model,
      attempts: phase1.attempts,
    };
  }

  const failoverModel = lookupFailover(opts.body.model);
  if (!failoverModel) {
    return {
      ok: false,
      error: phase1.error,
      lastProvider: opts.providerCfg.name,
      lastModel: opts.body.model,
      attempts: phase1.attempts,
    };
  }

  const resolved = await resolveProvider(opts.userId, failoverModel);
  if (!resolved.ok) {
    return {
      ok: false,
      error: phase1.error,
      lastProvider: opts.providerCfg.name,
      lastModel: opts.body.model,
      attempts: phase1.attempts,
    };
  }

  console.warn(
    `[tokensmart] stream failover ${opts.body.model}→${failoverModel} (${opts.providerCfg.name}→${resolved.config.name}) after ${phase1.attempts} failed attempt(s): ${phase1.error}`
  );

  const failoverBody: OpenAIChatRequest = { ...opts.body, model: failoverModel };
  const phase2 = await tryUpstreamStreamWithRetries({
    body: failoverBody,
    providerCfg: resolved.config,
    totalAttempts,
    baseDelay,
  });
  if (phase2.ok) {
    return {
      ok: true,
      upstream: phase2.upstream,
      lastProvider: resolved.config.name,
      lastModel: failoverModel,
      attempts: phase1.attempts + phase2.attempts,
    };
  }
  return {
    ok: false,
    error: `${phase1.error} | failover (${failoverModel}): ${phase2.error}`,
    lastProvider: resolved.config.name,
    lastModel: failoverModel,
    attempts: phase1.attempts + phase2.attempts,
  };
}

export async function tryUpstreamStreamWithRetries(opts: {
  body: OpenAIChatRequest;
  providerCfg: ProviderConfig;
  totalAttempts: number;
  baseDelay: number;
}): Promise<
  | {
      ok: true;
      upstream: Awaited<ReturnType<typeof callUpstreamStream>>;
      attempts: number;
    }
  | { ok: false; error: string; attempts: number }
> {
  const streamCall = streamCallForProvider(opts.providerCfg);
  let lastErr: string = "no attempts made";
  for (let attempt = 0; attempt < opts.totalAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelayMs(attempt - 1, opts.baseDelay));
    }
    try {
      const upstream = await streamCall(opts.body, opts.providerCfg);
      // Initial-connect status is on `upstream.status`. Only retry when it's
      // a transient code AND we haven't started streaming bytes (the
      // adapter returns a 1-frame SSE error in that case). For 2xx we
      // commit — even if the stream later errors mid-flight, that's the
      // client's problem to handle.
      if (!isRetryableStatus(upstream.status)) {
        return { ok: true, upstream, attempts: attempt + 1 };
      }
      lastErr = `HTTP ${upstream.status}`;
      if (attempt + 1 >= opts.totalAttempts) {
        // Out of retries — report failure so the failover layer can try a
        // configured alternate model before we give up.
        return { ok: false, error: lastErr, attempts: attempt + 1 };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (!isRetryableError(err)) {
        return { ok: false, error: lastErr, attempts: attempt + 1 };
      }
    }
  }
  return { ok: false, error: lastErr, attempts: opts.totalAttempts };
}

export const chatRoutes = new Hono();

/**
 * OpenAI-compatible chat completions proxy.
 *
 * Enforcement order (cheap → expensive, fail fast):
 *   1. Auth
 *   2. Parse request body
 *   3. Fingerprint — taken from the ORIGINAL body so loops are identified
 *      by what the caller sent, not by what we later routed to
 *   4. Loop detection (in-memory, microseconds)
 *   5. Semantic routing (may rewrite body.model)
 *   6. Provider routing (model → upstream)
 *   7. Budget check (single DB query)
 *   8. Forward to upstream
 *   9. Log full outcome
 *
 * Every rejection path still writes a row to `requests`.
 */
chatRoutes.post("/v1/chat/completions", async (c) => {
  // ---- Pre-allocate a request id ---------------------------------------
  // We mint the row id BEFORE we touch the upstream so the
  // `X-Tokensmart-Request-Id` header can leave on the very first byte —
  // including the SSE response, where the body starts streaming long
  // before the `requests` row gets written. Long-running agents
  // (OpenClaw is the motivating customer) capture this header and use
  // it to deep-link into the dashboard's request-detail page for
  // post-hoc cost / latency / failure analysis.
  //
  // The id is the EXACT value used as `requests.id` for the eventual
  // ledger row. There is no second mapping table.
  const requestId = randomUUID();
  c.header("X-Tokensmart-Request-Id", requestId);
  // Idiomatic alias that matches the de-facto convention used by Stripe,
  // Anthropic, and OpenAI's own gateway. Some clients only sniff one or
  // the other; setting both costs nothing.
  c.header("X-Request-Id", requestId);

  // ---- Body-size cap ----------------------------------------------------
  // Trust the Content-Length header for the fast-path reject — if a
  // client lies about it (under-reports), the `c.req.json()` below
  // still has to parse bytes, but Bun's json() parser has its own
  // reasonable upper bound (runtime-enforced). The goal of this check
  // is strictly "don't let a malicious client stream 2 GB into my
  // process RAM just because it said it was small". 413 is the right
  // RFC 9110 status; we include the limit in the error for operators
  // debugging a real-world integration.
  //
  // Only gates the chat completions path. /health, /internal/*, etc.
  // are either empty-body or operator-only and don't need this.
  const maxBodyBytes = env.TOKENSMART_MAX_BODY_BYTES;
  if (maxBodyBytes > 0) {
    const cl = c.req.header("content-length");
    if (cl) {
      const declared = Number(cl);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return c.json(
          {
            error: {
              message: `Request body exceeds gateway limit of ${maxBodyBytes} bytes (declared ${declared}). Increase TOKENSMART_MAX_BODY_BYTES on the gateway, or shrink the request.`,
              type: "payload_too_large",
            },
          },
          413
        );
      }
    }
  }

  // ---- Auth -------------------------------------------------------------
  const authHeader = c.req.header("Authorization") ?? "";
  const rawKey = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!rawKey) {
    return c.json({ error: { message: "Missing Authorization: Bearer <key>" } }, 401);
  }

  const apiKey = await findApiKey(rawKey);
  if (!apiKey) {
    return c.json({ error: { message: "Invalid API key" } }, 401);
  }

  touchApiKey(apiKey.id).catch(() => {});

  // ---- Parse customer attribution tags ---------------------------------
  // Combines two signal channels into one tag map:
  //   1. `x-ts-tag: feature=summarization,team=growth,user=u_42` (freeform)
  //   2. Well-known headers: `x-ts-agent`, `x-ts-session`, `x-ts-turn`,
  //      `x-ts-channel` — the four dimensions every long-running agent
  //      (OpenClaw, AutoGPT-style loops, LangGraph pipelines) wants
  //      first-class. Dedicated headers WIN over same-named freeform
  //      pairs because they're a more specific signal.
  // Stored on the request row; powers the dashboard's "Spend by tag"
  // card AND the per-session aggregation view. Always a plain object —
  // never null. Bad headers → empty object, not error.
  const tags = parseAttributionHeaders((name: string) => c.req.header(name));
  const classifierModelOverride = c.req.header("x-ts-classifier-model") ?? null;
  let compressedBlobEntries: Parameters<typeof storeCompressedBlobs>[2] = [];
  // If the request used a prompt template (filled in below), we'll stamp
  // its name+version onto the same `tags` map so the dashboard can group
  // spend by template version without a schema change.

  // ---- Parse request body ----------------------------------------------
  let body: OpenAIChatRequest;
  try {
    body = (await c.req.json()) as OpenAIChatRequest;
  } catch {
    return c.json({ error: { message: "Body must be valid JSON" } }, 400);
  }

  if (!body.model || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "Missing required field: model and messages[]" } }, 400);
  }
  stampDeclaredToolTags(tags, body);

  // ---- Prompt template substitution ------------------------------------
  // `x-ts-template: <name>[@<version>]` (optional). Loads the project's
  // saved template, renders {{var}} placeholders against
  //   body.ts_template_vars  +  x-ts-template-vars JSON header
  // (latter wins on key collision), and prepends/replaces the system
  // message. Runs BEFORE fingerprinting so loop detection counts the
  // expanded prompt — same template + same vars must collide on the
  // loop window. Template applies, then fingerprint, then routing —
  // routing/baseline policy classifies on the rendered messages.
  const templateRef = parseTemplateRef(c.req.header("x-ts-template"));
  if (templateRef) {
    if (!templateRef.ok) {
      return c.json(
        { error: { message: templateRef.error, type: "bad_template_header" } },
        400
      );
    }
    const lookup = await loadTemplate(apiKey.project_id, {
      name: templateRef.name,
      version: templateRef.version,
    });
    if (!lookup.ok) {
      return c.json(
        { error: { message: lookup.error, type: "unknown_template" } },
        400
      );
    }
    const headerVars = parseTemplateVarsHeader(c.req.header("x-ts-template-vars"));
    const bodyVars =
      body.ts_template_vars && typeof body.ts_template_vars === "object" && !Array.isArray(body.ts_template_vars)
        ? (body.ts_template_vars as Record<string, unknown>)
        : {};
    const vars = { ...bodyVars, ...headerVars };
    const rendered = renderTemplate(lookup.body, vars);
    applyTemplateToBody(body as Record<string, unknown>, rendered, vars);
    tags.template = lookup.name;
    tags.template_version = String(lookup.version);
  }

  // ---- Tool-result compression (opt-in, env-flagged) -------------------
  // When TOKENSMART_TOOL_COMPRESS_ENABLED=1, scan the messages array for
  // role=tool/function entries and apply content-aware compression
  // (git status / git diff / stack trace / NDJSON logs / ANSI strip /
  // consecutive-line dedup) BEFORE forwarding to upstream. Reduces the
  // billed input tokens on this turn AND every subsequent turn that
  // replays the same tool result back to the model.
  //
  // Runs AFTER template substitution (so we compress the rendered body
  // the upstream actually sees) and BEFORE fingerprinting (so a flood
  // of identical compressed bodies still collides on a stable
  // fingerprint — the compressor is deterministic + idempotent so this
  // is safe).
  //
  // Per-call escape hatch: send `x-ts-tool-compress: off` to bypass.
  // Useful when the agent is doing a one-off "give me the literal output"
  // workflow that would be hurt by compression.
  // Resolve the effective mode from the project policy + per-call header.
  // Headers honored: `x-ts-context-compress` (new) and the legacy
  // `x-ts-tool-compress` (back-compat). Either can only DOWNGRADE
  // (e.g. `off`) relative to the project default — a header can never
  // turn compression ON for a project that didn't opt in.
  if (TOOL_COMPRESS_POLICY.mode !== "off") {
    const headerVal =
      c.req.header("x-ts-context-compress") ??
      c.req.header("x-ts-tool-compress") ??
      null;
    const mode = resolveRequestMode(TOOL_COMPRESS_POLICY.mode, headerVal);
    if (mode !== "off") {
      // Snapshot originals BEFORE rewrite so the reversible store (M4) can
      // persist the untouched bytes. `compressContextMessages` returns a
      // NEW array in optimize mode, leaving this one intact.
      const originalMessages = body.messages as Array<{ content?: unknown }>;
      const { messages: compressed, result } = compressContextMessages(
        body.messages as Parameters<typeof compressContextMessages>[0],
        TOOL_COMPRESS_POLICY,
        mode
      );
      const charsSaved = result.totalCharsSaved;
      if (charsSaved > 0 && result.perMessage.length > 0) {
        const tokensSavedEst = estimateCompressedTokens(charsSaved);

        // Legacy `tool_compress_*` tags drive the dashboard's realized
        // savings hero. Stamp them ONLY when we actually rewrote the
        // prompt (optimize) so audit dry-runs never inflate the card.
        if (result.applied) {
          body.messages = compressed as typeof body.messages;
          tags.tool_compress_applied = "1";
          tags.tool_compress_chars_saved = String(charsSaved);
          tags.tool_compress_tokens_saved_est = String(tokensSavedEst);
          tags.tool_compress_messages_count = String(result.perMessage.length);
          if (result.perMessage[0]) {
            tags.tool_compress_shape = result.perMessage[0].shape;
          }
        }

        // New `context_compress_*` tags carry the richer receipt and fire
        // in BOTH audit and optimize so operators can A/B "what would we
        // have saved" before flipping a project to optimize.
        tags.context_compress_mode = mode;
        tags.context_compress_chars_saved = String(charsSaved);
        tags.context_compress_tokens_saved_est = String(tokensSavedEst);
        tags.context_compress_messages_count = String(result.perMessage.length);
        if (result.perMessage[0]) {
          tags.context_compress_shape = result.perMessage[0].shape;
        }

        // M4: reversible store. Capture the originals for the messages we
        // actually rewrote (optimize only). We persist them only AFTER the
        // request row exists, because the Postgres table has a FK to
        // requests(id). Storing here would fail every time on a fresh id.
        if (result.applied && TOOL_COMPRESS_POLICY.store) {
          const entries = result.perMessage
            .map((pm) => {
              const orig = originalMessages[pm.index]?.content;
              const comp = (compressed[pm.index] as { content?: unknown })?.content;
              if (typeof orig !== "string" || typeof comp !== "string") return null;
              return {
                messageIndex: pm.index,
                strategy: pm.shape,
                original: orig,
                compressed: comp,
              };
            })
            .filter((e): e is NonNullable<typeof e> => e !== null);
          if (entries.length > 0) {
            tags.context_compress_stored = "1";
            compressedBlobEntries = entries;
          }
        }
      }
    }
  }

  // ---- Fingerprint + loop detection ------------------------------------
  // Compute fingerprint BEFORE routing, so a flood of identical "hi"s keeps
  // one fingerprint even if we route them to a cheaper model.
  const fingerprint = fingerprintRequest(apiKey.project_id, body);
  const localLoop = loopDetector.recordAndCheck(fingerprint);
  const loop = await recordDurableLoopAndCheck(apiKey.project_id, fingerprint, {
    windowMs: localLoop.windowMs,
    threshold: localLoop.threshold,
  }).catch((err) => {
    console.warn(
      `[loop-detector] durable check failed; falling back to process-local window: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return localLoop;
  });

  if (loop.detected) {
    const windowMin = Math.round(loop.windowMs / 60_000);
    const humanMsg = `Likely agent loop: identical request repeated ${loop.count} times in the last ${windowMin} minutes. Blocking to protect your spend.`;
    const provider = findProviderTemplate(body.model)?.name ?? "unknown";

    const blockedRecord: InsertRequest = {
      project_id: apiKey.project_id,
      api_key_id: apiKey.id,
      provider,
      model: body.model,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      cost_micro_cents: 0,
      latency_ms: 0,
      status: "loop_detected",
      error: humanMsg,
      fingerprint,
      original_model: null,
      request_body: body,
      response_body: null,
      tags,
    };
    await insertRequest({ ...blockedRecord, id: requestId }).catch((e) =>
      console.error("Failed to insert loop-detected request:", e)
    );

    dispatchAlert(apiKey.project_id, "loop_detected", {
      fingerprint,
      model: body.model,
      count: loop.count,
      window_ms: loop.windowMs,
      threshold: loop.threshold,
    });

    // Loop-detect is a HARD refusal — retrying is exactly what would
    // make the problem worse. Return 403 + machine code so OpenAI-compat
    // client libraries with default 429-retry-with-backoff behavior
    // don't amplify the burst we just caught. Kept the `type` field on
    // the JSON body for backwards-compat with anything already parsing
    // that shape.
    applyRoutingDecisionHeaders(c, {
      askedModel: body.model,
      landedModel: body.model,
      routingReason: null,
      costMicroCents: 0,
      costSavedVsAskedMicroCents: 0,
    });
    return c.json(
      {
        error: {
          message: humanMsg,
          type: "loop_detected",
          code: "loop_detected",
          retryable: false,
          loop: {
            fingerprint,
            count: loop.count,
            window_ms: loop.windowMs,
            threshold: loop.threshold,
          },
        },
      },
      403
    );
  }

  // ---- Semantic routing ------------------------------------------------
  // May rewrite body.model. We remember the original for provenance + savings.
  const originalModel = String(body.model);
  // Snapshot before any mutation so the shadow A/B path can re-issue the
  // exact same prompt against an experimental model. Cheap thanks to
  // structuredClone — we already JSON.stringify the body for upstream anyway.
  const bodySnapshot: OpenAIChatRequest = structuredClone(body);
  const routing = await applyRouting(apiKey.project_id, body, {
    userId: apiKey.project_user_id,
    classifierModelOverride,
  });
  // If the project didn't define a matching rule, fall through to the
  // built-in baseline (cold-start) policy derived from public agent
  // benchmarks. Zero DB + zero network — one in-memory lookup.
  let baseline = null as Awaited<ReturnType<typeof applyBaselineRouting>> | null;
  if (!routing.routed) {
    // Pick the first tag value from the parsed `x-ts-tag` map as the
    // policy lookup key. If the request carried no tags, this is null
    // and the loader falls back to the project-default policy. Picking
    // the first tag (instead of, say, the alphabetically-smallest one)
    // means the customer can control which tag drives routing by
    // listing it first; we expose that contract intentionally.
    const policyTag = Object.keys(tags)[0] ?? null;
    baseline = await applyBaselineRouting(apiKey.project_id, body, policyTag, {
      userId: apiKey.project_user_id,
      classifierModelOverride,
    });
    if (baseline.applied) {
      console.log(
        `[tokensmart] baseline routing: ${baseline.from_model} → ${baseline.to_model} (${baseline.reason})`
      );
    }
  }
  const baselineApplied = !!baseline && baseline.applied;
  const recordedOriginalModel =
    routing.routed || baselineApplied ? originalModel : null;
  const shadowModel = routing.shadow_model;

  // ---- Provenance for the requests-row routing_reason/bucket cols ------
  // Stamped on every InsertRequest so the dashboard's /routing-quality
  // page can split traffic by the policy bucket the baseline classifier
  // actually picked, AND so /requests/[id] shows operators why a model
  // was downgraded. Two channels:
  //   - project routing_rules: reason carries the rule id + the pattern
  //     it matched, bucket is null (rules aren't bucket-aware).
  //   - baseline policy: reason is the existing log-formatted string,
  //     bucket is `${task_type}:${complexity}` of the resolved bucket
  //     the recommendation came from.
  // Both null when nothing rewrote body.model.
  const routingReason: string | null = routing.routed
    ? `rule:${routing.rule_id}:from=${routing.from_model}:to=${routing.to_model}`
    : baseline && baseline.applied
      ? baseline.reason
      : baseline && baseline.reason
        // Baseline ran but found no actionable pick (no_cheaper:bucket,
        // no_callable_cheaper:bucket, unknown_caller_model, ...). Persist
        // the reason verbatim so the dashboard receipt can explain WHY no
        // rewrite happened instead of falling back to the generic "no
        // routing reason recorded" copy. Same string shape as applied=true,
        // just describing the skip rather than the route taken.
        ? baseline.reason
        : null;
  const routingBucket: string | null =
    baseline && baseline.applied
      ? `${baseline.task_type}:${baseline.complexity}`
      : null;

  // ---- Route to upstream provider --------------------------------------
  // Must run AFTER semantic routing in case the new model lives on a
  // different provider than the original. Tries the user's BYO key first,
  // then falls back to gateway-env-configured credentials.
  const resolved = await resolveProvider(apiKey.project_user_id, body.model);
  if (!resolved.ok) {
    // L5: record the rejection so operators can see which unsupported
    // models users are asking for. Aggregate upsert keyed by
    // (model, reason, project) — heavy hitters just bump a counter.
    // Best-effort; a telemetry hiccup must not shadow the already-
    // failing request response. The `as const` below narrows the
    // union for TS; runtime shape is the same.
    recordModelRejection({
      model: body.model,
      reason: resolved.reason as "no_template" | "no_credentials",
      providerGuess: resolved.providerName ?? null,
      projectId: apiKey.project_id,
    }).catch((err) =>
      console.warn(
        `[chat] recordModelRejection failed for '${body.model}' (${resolved.reason}): ${(err as Error).message}`
      )
    );

    // v0.6.7: also write a per-request row into `requests` so an
    // operator investigating "openclaw chat shows HTTP 400 but DB has
    // no row" finds the failure in /requests like every other failure
    // mode. The L5 aggregate is for hit-counts ("which models are
    // hammering us?"); this row is for "show me the specific request
    // that 400'd" — both are kept. Failed-request rows use
    // status='error' (the existing dashboard catch-all upstream-error
    // bucket already includes them — no schema change required) with
    // a descriptive `error` text so operators can sort/filter by
    // reason in the per-row view.
    const failureReason =
      resolved.reason === "no_template"
        ? `no_provider_for_model: '${body.model}'`
        : `no_credentials_for_provider: ${resolved.providerName ?? "unknown"}`;
    const resolveFailRecord: InsertRequest = {
      project_id: apiKey.project_id,
      api_key_id: apiKey.id,
      // For no_template we have no provider name to attribute the row
      // to — `unknown` is the natural placeholder so the dashboard
      // doesn't show a misleading provider badge. For no_credentials
      // we know exactly which template matched; use it.
      provider: resolved.providerName ?? "unknown",
      model: body.model,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      cost_micro_cents: 0,
      cache_savings_micro_cents: 0,
      latency_ms: 0,
      status: "error",
      error: failureReason,
      fingerprint,
      original_model: recordedOriginalModel,
      streamed: false,
      request_body: body,
      response_body: null,
      tags,
    };
    insertRequest({
      ...resolveFailRecord,
      id: requestId,
      routing_reason: routingReason,
      routing_bucket: routingBucket,
    }).catch((e) =>
      console.error("Failed to insert resolve-failed request:", e)
    );

    applyRoutingDecisionHeaders(c, {
      askedModel: originalModel,
      landedModel: body.model,
      routingReason: routingReason,
      costMicroCents: 0,
      costSavedVsAskedMicroCents: 0,
    });
    if (resolved.reason === "no_template") {
      return c.json(
        {
          error: {
            message: `Unrecognized model '${body.model}'. TokSuan routes by model-name pattern; no provider matches this name. Register a custom upstream in Settings → Custom providers if you're using an arbitrary OpenAI-compatible endpoint.`,
            type: "no_provider_for_model",
          },
        },
        400
      );
    }
    const envAvailable = env.providers.map((p) => p.name).join(", ") || "(none)";
    return c.json(
      {
        error: {
          message:
            `No credentials configured for ${resolved.providerName} (model '${body.model}'). ` +
            (apiKey.project_user_id
              ? `Add a ${resolved.providerName} key in the dashboard under Settings → Provider keys, or `
              : "") +
            `set ${resolved.providerName?.toUpperCase()}_API_KEY in this gateway's env. Currently env-configured: ${envAvailable}.`,
          type: "no_credentials_for_provider",
        },
      },
      400
    );
  }
  const providerCfg = resolved.config;
  const provider = providerCfg.name;
  let budgetReservationIds: string[] = [];
  let planReservationIds: string[] = [];
  const releaseReservedBudget = async () => {
    if (budgetReservationIds.length === 0 && planReservationIds.length === 0) {
      return;
    }
    const budgetIds = budgetReservationIds;
    const planIds = planReservationIds;
    budgetReservationIds = [];
    planReservationIds = [];
    await Promise.all([
      budgetIds.length > 0
        ? releaseBudgetReservations(budgetIds).catch((e) =>
            console.error("Failed to release budget reservation:", e)
          )
        : Promise.resolve(),
      planIds.length > 0
        ? releasePlanReservations(planIds).catch((e) =>
            console.error("Failed to release plan reservation:", e)
          )
        : Promise.resolve(),
    ]);
  };

  // ---- Plan (hosted-tier) enforcement via reservation ------------------
  // Runs only when the project has a user with a plan — i.e. hosted
  // mode. Self-hosted installs are unaffected because `getProjectPlan`
  // returns null in SQLite mode and on rows with no user.
  //
  // Enforces TWO caps per plan in a SINGLE atomic transaction (see
  // `reservePlanForRequest`), whichever hits first:
  //   1. dailyMicroCentsLimit — rolling-24h spend across the user's
  //      projects + pending plan reservations.
  //   2. monthlyRequestLimit  — rolling-30d successful request count
  //      across the user's projects + pending plan reservations.
  //
  // Estimating spend up front matters: a Free-tier user firing 20
  // parallel agent turns used to all pass the gate at the same pre-
  // burst spend value and overshoot together. The reservation table
  // makes the next concurrent request see committed + pending spend
  // and block atomically.
  //
  // Plan caps of `Number.POSITIVE_INFINITY` (Team / Scale) skip the
  // gate cheaply — `reservePlanForRequest` short-circuits with a
  // null reservation_id so `releasePlanReservations` is a no-op.
  const planCtx = await getProjectPlan(apiKey.project_id);
  if (planCtx) {
    const limits = limitsForPlan(planCtx.plan);
    const dailyLimit = limits.dailyMicroCentsLimit;
    const monthlyLimit = limits.monthlyRequestLimit;

    const planEstimate = estimateChatCostMicroCents(provider, body.model, body);
    const planAttempt = await reservePlanForRequest(
      planCtx.user_id,
      planEstimate.estimated_micro_cents,
      dailyLimit,
      monthlyLimit
    );

    if (!planAttempt.ok) {
      const dailyExceeded = planAttempt.trigger === "daily_spend";
      const dailyUsd = (dailyLimit / 100_000).toFixed(2);
      const committedUsd = (planAttempt.committed / 100_000).toFixed(4);
      const reservedUsd = (planAttempt.reserved / 100_000).toFixed(4);
      const humanMsg = dailyExceeded
        ? `Plan limit reached on the ${planCtx.plan} tier: $${dailyUsd}/24h cap; ` +
          `already tracked $${committedUsd} + $${reservedUsd} in-flight reserved. ` +
          `Upgrade or wait for the window to roll over.`
        : `Plan limit reached on the ${planCtx.plan} tier: ` +
          `${monthlyLimit.toLocaleString("en-US")} requests / 30d cap; ` +
          `already used ${planAttempt.committed.toLocaleString("en-US")} + ` +
          `${planAttempt.reserved.toLocaleString("en-US")} in-flight reserved. ` +
          `Upgrade or wait for the window to roll over.`;

      const blockedRecord: InsertRequest = {
        project_id: apiKey.project_id,
        api_key_id: apiKey.id,
        provider,
        model: body.model,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
        cost_micro_cents: 0,
        latency_ms: 0,
        // Distinct from project-budget blocks so downstream aggregates
        // (Spend by project / dashboard blocked-count / anomaly detector)
        // can tell "user hit their Free-tier daily ceiling" apart from
        // "a project-scoped budget rule fired". Mixing them breaks the
        // "Blocked X requests over budget" home-page copy and would
        // fan false positives into per-project anomaly alerts.
        status: "plan_limit_exceeded",
        error: humanMsg,
        fingerprint,
        original_model: recordedOriginalModel,
        request_body: body,
        response_body: null,
        tags,
      };
      await insertRequest({
        ...blockedRecord,
        id: requestId,
        routing_reason: routingReason,
        routing_bucket: routingBucket,
      }).catch((e) =>
        console.error("Failed to insert plan-blocked request:", e)
      );

      // Plan-cap hit is a HARD block (upgrade or wait for rollover) —
      // returning 429 causes OpenAI-SDK-family clients to retry with
      // exponential backoff, which accomplishes nothing and spams our
      // logs. 402 Payment Required is the semantic match + Stripe
      // convention, and most clients don't auto-retry it.
      applyRoutingDecisionHeaders(c, {
        askedModel: originalModel,
        landedModel: body.model,
        routingReason: routingReason,
        costMicroCents: 0,
        costSavedVsAskedMicroCents: 0,
      });
      return c.json(
        {
          error: {
            message: humanMsg,
            type: "plan_limit_exceeded",
            code: "plan_limit_exceeded",
            retryable: false,
            plan: {
              name: planCtx.plan,
              daily_limit_micro_cents: dailyLimit,
              monthly_request_limit: monthlyLimit,
              spent_micro_cents:
                planAttempt.trigger === "daily_spend"
                  ? planAttempt.committed
                  : 0,
              reserved_spend_micro_cents:
                planAttempt.trigger === "daily_spend"
                  ? planAttempt.reserved
                  : 0,
              monthly_request_count:
                planAttempt.trigger === "monthly_requests"
                  ? planAttempt.committed
                  : 0,
              reserved_request_count:
                planAttempt.trigger === "monthly_requests"
                  ? planAttempt.reserved
                  : 0,
              trigger: planAttempt.trigger,
            },
          },
        },
        402
      );
    }
    if (planAttempt.reservation_id) {
      planReservationIds.push(planAttempt.reservation_id);
    }
  }

  // ---- Budget enforcement ----------------------------------------------
  const budget = await checkAndReserveBudget(
    apiKey.project_id,
    provider,
    body.model,
    body
  );
  if (!budget.ok) {
    const limitUsd = (budget.limit_micro_cents / 100_000).toFixed(4);
    const spendUsd = (budget.spend_micro_cents / 100_000).toFixed(4);
    const reservedUsd = (budget.reserved_micro_cents / 100_000).toFixed(4);
    const requestedUsd = (budget.requested_micro_cents / 100_000).toFixed(4);
    const humanMsg =
      `Budget would be exceeded for the ${budget.period} period. ` +
      `Limit $${limitUsd}, already spent $${spendUsd}, ` +
      `in-flight reserved $${reservedUsd}, this request estimated $${requestedUsd}.`;

    const blockedRecord: InsertRequest = {
      project_id: apiKey.project_id,
      api_key_id: apiKey.id,
      provider,
      model: body.model,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      cost_micro_cents: 0,
      latency_ms: 0,
      status: "budget_exceeded",
      error: humanMsg,
      fingerprint,
      original_model: recordedOriginalModel,
      request_body: body,
      response_body: null,
      tags,
    };
    await insertRequest({
      ...blockedRecord,
      id: requestId,
      routing_reason: routingReason,
      routing_bucket: routingBucket,
    }).catch((e) =>
      console.error("Failed to insert blocked request:", e)
    );

    dispatchAlert(apiKey.project_id, "budget_exceeded", {
      period: budget.period,
      limit_micro_cents: budget.limit_micro_cents,
      spend_micro_cents: budget.spend_micro_cents,
      reserved_micro_cents: budget.reserved_micro_cents,
      requested_micro_cents: budget.requested_micro_cents,
      model: body.model,
    });

    // Project-budget stays on 429 (semantically "too many successful
    // requests this period") with an explicit `retryable: true` + a
    // best-effort `Retry-After` header pointing at the period rollover.
    // Clients that sleep-and-retry actually help here: by the time the
    // daily/monthly window rolls over they'll get through.
    const now = new Date();
    let retryAfterSec: number;
    if (budget.period === "daily") {
      const next = new Date(now);
      next.setUTCHours(24, 0, 0, 0);
      retryAfterSec = Math.ceil((next.getTime() - now.getTime()) / 1000);
    } else {
      const next = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
      );
      retryAfterSec = Math.ceil((next.getTime() - now.getTime()) / 1000);
    }

    applyRoutingDecisionHeaders(c, {
      askedModel: originalModel,
      landedModel: body.model,
      routingReason: routingReason,
      costMicroCents: 0,
      costSavedVsAskedMicroCents: 0,
    });
    await releaseReservedBudget();
    return c.json(
      {
        error: {
          message: humanMsg,
          type: "budget_exceeded",
          code: "budget_exceeded",
          retryable: true,
          retry_after_seconds: retryAfterSec,
          budget: {
            period: budget.period,
            limit_micro_cents: budget.limit_micro_cents,
            spend_micro_cents: budget.spend_micro_cents,
            reserved_micro_cents: budget.reserved_micro_cents,
            requested_micro_cents: budget.requested_micro_cents,
          },
        },
      },
      429,
      { "Retry-After": String(retryAfterSec) }
    );
  }
  budgetReservationIds = budget.reservation_ids;
  // When the reservation amount came from a fallback price (the model
  // wasn't in our table), surface that on the row so an operator
  // looking at /requests/[id] knows the dollar number was a worst-case
  // GUESS, not the real cost. Skipped on the common-case `exact` basis
  // to keep tag rows tight.
  if (budget.pricing_basis && budget.pricing_basis !== "exact") {
    tags.reservation_basis = budget.pricing_basis;
  }

  // ---- Anthropic auto cache_control (mutates body in place) ------------
  // Cheap and idempotent. Skipped for non-Anthropic providers, opt-out via
  // TOKENSMART_AUTO_CACHE_CONTROL=0.
  //
  // When injection actually tags something, stamp the result onto `tags`
  // so the row carries a permanent breadcrumb regardless of the
  // request_body storage mode. The body itself gets sampled out on 99%
  // of success rows under the default `sample` policy, so reading the
  // raw stored body is NOT a reliable way to confirm injection
  // happened — the tag is. Doubles as an ops signal: an operator
  // grouping Spend-by-tag can see what fraction of Anthropic spend is
  // cache-eligible vs not.
  if (env.TOKENSMART_AUTO_CACHE_CONTROL !== "0") {
    const cci = injectAnthropicCacheControl(body, providerCfg);
    if (cci.applied) {
      const segs: string[] = [];
      if (cci.taggedSystem) segs.push("system");
      if (cci.taggedTools) segs.push("tools");
      if (cci.taggedHistory) segs.push("history");
      // Comma-separated rather than a JSON array because the rest of the
      // tags map is `Record<string, string>` (see `tags.ts`); keeping
      // values as flat strings means the dashboard's existing tag-key /
      // tag-value table doesn't need a special-case.
      tags.cache_control = segs.join(",");
    }
  }

  // ---- Semantic cache lookup (non-stream path only) --------------------
  // Disabled by default; gated on TOKENSMART_CACHE_ENABLED=1. When a hit
  // lands, we serve the cached response, write a request row at cost=$0
  // tagged `cached_by`, and skip upstream + shadow entirely. Streaming
  // requests deliberately bypass — see the `notCacheable` checks in
  // semantic-cache.ts.
  const wantsStreamForCache = body.stream === true;
  const cacheLookup = wantsStreamForCache
    ? null
    : await lookupSemanticCache(apiKey.project_id, body);
  if (cacheLookup && cacheLookup.hit) {
    const cacheLatency = 0; // sub-ms; not worth measuring here
    const cacheTags = {
      ...tags,
      cached_by:
        cacheLookup.kind === "exact"
          ? "tokensmart-exact"
          : "tokensmart-similarity",
      ...(cacheLookup.kind === "similarity" && cacheLookup.similarity
        ? { cache_similarity: cacheLookup.similarity.toFixed(3) }
        : {}),
    };
    stampResponseToolCallTags(
      cacheTags,
      cacheLookup.responseBody,
      "cached_response"
    );
    const cachedRecord: InsertRequest = {
      project_id: apiKey.project_id,
      api_key_id: apiKey.id,
      provider,
      model: body.model,
      input_tokens: cacheLookup.inputTokens,
      cached_input_tokens: cacheLookup.cachedInputTokens,
      output_tokens: cacheLookup.outputTokens,
      cost_cents: 0,
      cost_micro_cents: 0,
      cache_savings_micro_cents: 0,
      latency_ms: cacheLatency,
      status: "success",
      error: null,
      fingerprint,
      original_model: recordedOriginalModel,
      streamed: false,
      request_body: body,
      response_body: cacheLookup.responseBody,
      tags: cacheTags,
    };
    await insertRequest({
      ...cachedRecord,
      id: requestId,
      routing_reason: routingReason,
      routing_bucket: routingBucket,
    }).catch((e) =>
      console.error("Failed to insert cache-served request:", e)
    );
    await releaseReservedBudget();
    // Cost is zero because the cached response was served without an
    // upstream call. The "saved vs asked" header stays at zero too —
    // routing-saving is the routing-attribution metric (asked-model
    // hypothetical minus actually-ran cost), and a cache hit didn't
    // run the asked model. Cache savings are a separate dimension
    // (the requests row carries `cached_by` tag for that audit).
    applyRoutingDecisionHeaders(c, {
      askedModel: originalModel,
      landedModel: body.model,
      routingReason: routingReason,
      costMicroCents: 0,
      costSavedVsAskedMicroCents: 0,
    });
    return c.json(cacheLookup.responseBody, 200);
  }

  // ---- Forward to upstream ---------------------------------------------
  const start = Date.now();
  // Allocate a trace + span ID up front so we can stamp them on the audit
  // row AND on the OTel export. No-op if OTel isn't configured.
  const traceId = newTraceId();
  const spanId = newSpanId();
  const wantsStream = body.stream === true;

  // ---- Streaming branch (SSE pass-through) -----------------------------
  if (wantsStream) {
    // Retry+failover on the INITIAL upstream connect only. Once SSE bytes
    // start flowing we can't safely retry — the client is already receiving
    // partial output. Initial connect failures (5xx, refused, timeout) are
    // by far the dominant failure mode in practice.
    let streamAttempt = await callStreamWithRetryAndFailover({
      body,
      providerCfg,
      provider,
      userId: apiKey.project_user_id,
    });

    // ---- v0.6.7 rewrite-failure auto-fallback (streaming) -------------
    // Symmetric to the non-stream path: when the upstream returned a 4xx
    // because the rewritten model name is invalid for the upstream
    // (provider rejects a stale rewritten model id), retry once with
    // the caller's original model. We can do this safely BEFORE the
    // SSE pass-through Response is built, because the openai/anthropic
    // adapters parse the JSON error body up front and expose it on
    // `upstream.errorBody` for cases where status is non-2xx (the
    // SSE stream itself wraps the same body in a single error frame).
    if (
      streamAttempt.ok &&
      rewriteFallbackEnabled() &&
      recordedOriginalModel &&
      recordedOriginalModel !== streamAttempt.lastModel &&
      isRewriteFailure4xx(
        streamAttempt.upstream.status,
        streamAttempt.upstream.errorBody
      )
    ) {
      const fallbackResolved = await resolveProvider(
        apiKey.project_user_id,
        recordedOriginalModel
      );
      if (fallbackResolved.ok) {
        console.warn(
          `[tokensmart] stream rewrite-failure 4xx (${streamAttempt.upstream.status}) on ${streamAttempt.lastModel}; ` +
            `auto-falling back to caller's original model ${recordedOriginalModel} ` +
            `(${fallbackResolved.config.name})`
        );
        body.model = recordedOriginalModel;
        const fallbackAttempt = await callStreamWithRetryAndFailover({
          body,
          providerCfg: fallbackResolved.config,
          provider: fallbackResolved.config.name,
          userId: apiKey.project_user_id,
        });
        if (
          fallbackAttempt.ok &&
          fallbackAttempt.upstream.status >= 200 &&
          fallbackAttempt.upstream.status < 300
        ) {
          // Drain (and discard) the SSE error stream from the failed
          // first attempt so its underlying socket releases — leaving
          // it un-read would keep the upstream connection alive in
          // CLOSE_WAIT until GC.
          streamAttempt.upstream.stream
            .cancel()
            .catch(() => {});
          streamAttempt = fallbackAttempt;
          tags.auto_fallback = "rewrite_4xx_fallback";
        } else {
          // Fallback also failed. Cancel the (newly-created) failed
          // fallback stream so its socket releases; keep the original
          // 4xx stream as the response so the caller sees the
          // upstream's error message verbatim.
          if (fallbackAttempt.ok) {
            fallbackAttempt.upstream.stream.cancel().catch(() => {});
          }
          body.model = streamAttempt.lastModel;
          tags.auto_fallback = "rewrite_4xx_fallback_failed";
        }
      }
    }

    if (!streamAttempt.ok) {
      const upstreamErr = streamAttempt.error;
      const failedRecord: InsertRequest = {
        project_id: apiKey.project_id,
        api_key_id: apiKey.id,
        provider: streamAttempt.lastProvider,
        model: streamAttempt.lastModel,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
        cost_micro_cents: 0,
        cache_savings_micro_cents: 0,
        latency_ms: Date.now() - start,
        status: "error",
        error: upstreamErr,
        fingerprint,
        original_model: recordedOriginalModel,
        streamed: true,
        request_body: body,
        response_body: null,
        tags,
      };
      insertRequest({
        ...failedRecord,
        id: requestId,
        routing_reason: routingReason,
        routing_bucket: routingBucket,
      }).catch((e) =>
        console.error("Failed to insert request:", e)
      );
      await releaseReservedBudget();
      applyRoutingDecisionHeaders(c, {
        askedModel: originalModel,
        landedModel: streamAttempt.lastModel,
        routingReason: routingReason,
        costMicroCents: 0,
        costSavedVsAskedMicroCents: 0,
      });
      return c.json(
        {
          error: {
            message: "Upstream provider request failed",
            detail: upstreamErr,
          },
        },
        502
      );
    }

    // The retry+failover layer may have swapped the upstream model. Use the
    // FINAL provider/model when computing cost + writing the request row,
    // so the dashboard reflects what actually executed.
    const upstream = streamAttempt.upstream;
    const effectiveProvider = streamAttempt.lastProvider;
    const effectiveModel = streamAttempt.lastModel;
    if (effectiveModel !== body.model) {
      // Failover happened — record the swap on the body so logging / shadow
      // dispatch see the model that actually ran.
      body.model = effectiveModel;
    }

    // Once the upstream stream drains, log the request row. We DO NOT await
    // this in the response path — the client has already disconnected by then.
    upstream.done
      .then(async (final) => {
        try {
        const totalLatency = Date.now() - start;
        const costMicroCents = calcCostMicroCents(
          effectiveProvider,
          effectiveModel,
          final.inputTokens,
          final.outputTokens,
          final.cachedInputTokens
        );
        const cacheSavings = calcCacheSavingsMicroCents(
          effectiveProvider,
          effectiveModel,
          final.cachedInputTokens
        );
        const originalProvider = recordedOriginalModel
          ? (findProviderTemplate(recordedOriginalModel)?.name ?? null)
          : null;
        const routingSaving = calcRoutingSavingMicroCents(
          originalProvider,
          recordedOriginalModel,
          effectiveModel,
          final.inputTokens,
          final.outputTokens,
          final.cachedInputTokens,
          costMicroCents
        );
        const status =
          final.errorMessage != null
            ? "error"
            : upstream.status >= 200 && upstream.status < 300
              ? "success"
              : "error";
        if (final.finishReason === "tool_calls") {
          // Streaming chunks are forwarded unmodified, so we do not buffer
          // tool-call arguments for the ledger. The finish reason still tells
          // operators that this turn ended by asking the agent to execute a
          // tool.
          tags.tool_calls_observed = "stream_finish_reason";
        }
        // Reprice the compressor's saved input tokens at the model that
        // actually executed (failover may have swapped it). No-op when
        // the compressor didn't fire on this request.
        stampToolCompressMicroCentsSaved(tags, effectiveProvider, effectiveModel);
        const record: InsertRequest = {
          project_id: apiKey.project_id,
          api_key_id: apiKey.id,
          provider: effectiveProvider,
          model: effectiveModel,
          input_tokens: final.inputTokens,
          cached_input_tokens: final.cachedInputTokens,
          output_tokens: final.outputTokens,
          cost_cents: microCentsToCents(costMicroCents),
          cost_micro_cents: costMicroCents,
          cache_savings_micro_cents: cacheSavings,
          routing_saving_micro_cents: routingSaving,
          latency_ms: totalLatency,
          status,
          error: final.errorMessage,
          fingerprint,
          original_model: recordedOriginalModel,
          streamed: true,
          request_body: body,
          // For streamed responses we store a compact summary instead of the
          // full reconstructed text — agents typically run thousands of these
          // and we don't want to bloat Postgres.
          response_body: {
            streamed: true,
            content_chars: final.contentChars,
            finish_reason: final.finishReason,
          },
          tags,
        };
        const inserted = await insertRequest({
          ...record,
          id: requestId,
          routing_reason: routingReason,
          routing_bucket: routingBucket,
        }).catch((e) => {
          console.error("Failed to insert streamed request:", e);
          return null;
        });
        if (inserted && compressedBlobEntries.length > 0) {
          await storeCompressedBlobs(
            apiKey.project_id,
            requestId,
            compressedBlobEntries
          ).catch((e) =>
            console.warn(
              `[context-compress] blob store failed for ${requestId}: ${
                e instanceof Error ? e.message : String(e)
              }`
            )
          );
        }

        recordSpan({
          traceId,
          spanId,
          name: "chat.completions",
          kind: "server",
          startTimeMs: start,
          endTimeMs: start + totalLatency,
          status: status === "success" ? "ok" : "error",
          errorMessage: record.error ?? undefined,
          attributes: {
            "tokensmart.project_id": apiKey.project_id,
            "tokensmart.request_id": inserted?.id ?? null,
            "tokensmart.original_model": recordedOriginalModel,
            "tokensmart.routed": recordedOriginalModel != null,
            "tokensmart.streamed": true,
            "tokensmart.cost_micro_cents": costMicroCents,
            "tokensmart.routing_saving_micro_cents": routingSaving,
            "tokensmart.cache_savings_micro_cents": cacheSavings,
            "gen_ai.system": effectiveProvider,
            "gen_ai.request.model": effectiveModel,
            "gen_ai.response.model": effectiveModel,
            "gen_ai.usage.input_tokens": final.inputTokens,
            "gen_ai.usage.output_tokens": final.outputTokens,
            "gen_ai.usage.cached_tokens": final.cachedInputTokens,
            "http.response.status_code": upstream.status,
          },
        });

        if (shadowModel && status === "success") {
          dispatchShadow({
            projectId: apiKey.project_id,
            userId: apiKey.project_user_id,
            fingerprint,
            primaryRequestId: inserted?.id ?? null,
            primaryModel: effectiveModel,
            primaryProvider: effectiveProvider,
            primaryInputTokens: final.inputTokens,
            primaryOutputTokens: final.outputTokens,
            primaryCachedInputTokens: final.cachedInputTokens,
            primaryCostMicroCents: costMicroCents,
            primaryLatencyMs: totalLatency,
            shadowModel,
            body: bodySnapshot,
          });
        }
        } finally {
          await releaseReservedBudget();
        }
      })
      .catch(async (e) => {
        console.error("Failed to insert streamed request:", e);
        await releaseReservedBudget();
      });

    return new Response(upstream.stream, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        // Hono's c.header() runs through the response constructor it
        // builds for c.json() / c.text() — when we hand back our own
        // Response (the SSE pass-through), those headers don't carry
        // over. Re-stamp them by hand so the OpenClaw client can still
        // grab the request id off a streaming response.
        "X-Request-Id": requestId,
        "X-Tokensmart-Request-Id": requestId,
        // Routing-decision headers: cost not yet known at SSE-flush
        // time, so emit only the model + reason trio. Operators read
        // the cost off the request row by following X-Tokensmart-
        // Request-Id; the streaming success path is the one place
        // where same-trip cost-in-headers is fundamentally impossible.
        // Tool-compress chars/savings ARE known at this point (the
        // compressor ran before SSE handoff) so we surface them
        // even on stream — just micro-cents priced at the model
        // that flushed first, not the one that ultimately ran if
        // failover swaps mid-stream.
        ...buildRoutingDecisionHeaders({
          askedModel: originalModel,
          landedModel: effectiveModel,
          routingReason: routingReason,
          ...readToolCompressFromTags(tags),
          // readToolCompressFromTags returns { chars, microCents }; the
          // header builder expects toolCompressCharsSaved /
          // toolCompressMicroCentsSaved. Spread + remap explicitly so
          // typos can't silently drop fields.
        }),
      },
    });
  }

  // ---- Non-streaming branch --------------------------------------------
  // Retry+failover wraps the upstream call. Transient 5xx / 408 / 429 / network
  // errors retry against the same provider; persistent failures fall over to
  // the model in TOKENSMART_FAILOVER_MAP if one is configured.
  let attempt = await callWithRetryAndFailover({
    body,
    providerCfg,
    provider,
    userId: apiKey.project_user_id,
  });

  // ---- v0.6.7 rewrite-failure auto-fallback ----------------------------
  // When baseline routing rewrote `originalModel` → `body.model` AND
  // the upstream returned a 4xx that looks like "model is the
  // problem" (e.g. an upstream 4xx on a stale model rewrite), retry ONCE
  // with the caller's original model.
  // The user's INTENT is what survives — they asked for X, the
  // gateway second-guessed with Y, Y was upstream-invalid, so we
  // honor the original X. Tagged on the row so operators can
  // measure how often this safety net fires (target: very rarely;
  // a high rate means the policy artifact is stale and needs a
  // bench:extract refresh).
  if (
    attempt.ok &&
    rewriteFallbackEnabled() &&
    recordedOriginalModel &&
    recordedOriginalModel !== attempt.lastModel &&
    isRewriteFailure4xx(attempt.result.status, attempt.result.body)
  ) {
    const fallbackResolved = await resolveProvider(
      apiKey.project_user_id,
      recordedOriginalModel
    );
    if (fallbackResolved.ok) {
      console.warn(
        `[tokensmart] rewrite-failure 4xx (${attempt.result.status}) on ${attempt.lastModel}; ` +
          `auto-falling back to caller's original model ${recordedOriginalModel} ` +
          `(${fallbackResolved.config.name})`
      );
      // Restore the original model on the body so logging / OTel /
      // shadow dispatch all see what actually executed. The previous
      // attempt's body is the same reference (we didn't deep-clone
      // for the failover layer), but body.model was set to the
      // rewritten value — flip it back.
      body.model = recordedOriginalModel;
      const fallbackAttempt = await callWithRetryAndFailover({
        body,
        providerCfg: fallbackResolved.config,
        provider: fallbackResolved.config.name,
        userId: apiKey.project_user_id,
      });
      // Only PROMOTE the fallback to the primary outcome when it
      // actually 2xx'd. Cascading two failures (4xx + 4xx) into a
      // single confused row would be worse than the original.
      if (
        fallbackAttempt.ok &&
        fallbackAttempt.result.status >= 200 &&
        fallbackAttempt.result.status < 300
      ) {
        attempt = fallbackAttempt;
        // Operator-visible breadcrumb: tag the row so /requests can
        // filter "show me requests that auto-fell-back" + dashboard
        // can compute a per-week rate. Distinct from the existing
        // `cached_by` / `reservation_basis` tag idiom — same map.
        tags.auto_fallback = "rewrite_4xx_fallback";
      } else {
        // Fallback also failed. Keep the original 4xx response so
        // the caller sees the upstream's error message verbatim
        // (which is the diagnostic they need); also restore body.model
        // for the row write below so the bookkeeping reflects what
        // we attempted last (the rewritten model that 4xx'd).
        body.model = attempt.lastModel;
        // Tag so operators see the safety net was tried + lost.
        tags.auto_fallback = "rewrite_4xx_fallback_failed";
      }
    }
  }

  if (!attempt.ok) {
    const totalLatency = Date.now() - start;
    const failedRecord: InsertRequest = {
      project_id: apiKey.project_id,
      api_key_id: apiKey.id,
      provider: attempt.lastProvider,
      model: attempt.lastModel,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      cost_micro_cents: 0,
      cache_savings_micro_cents: 0,
      latency_ms: totalLatency,
      status: "error",
      error: attempt.error,
      fingerprint,
      original_model: recordedOriginalModel,
      streamed: false,
      request_body: body,
      response_body: null,
      tags,
    };
    await insertRequest({
      ...failedRecord,
      id: requestId,
      routing_reason: routingReason,
      routing_bucket: routingBucket,
    }).catch((e) => console.error("Failed to insert request:", e));
    await releaseReservedBudget();
    applyRoutingDecisionHeaders(c, {
      askedModel: originalModel,
      landedModel: attempt.lastModel,
      routingReason: routingReason,
      costMicroCents: 0,
      costSavedVsAskedMicroCents: 0,
    });
    return c.json(
      { error: { message: "Upstream provider request failed", detail: attempt.error } },
      502
    );
  }

  const result = attempt.result;
  const effectiveProvider = attempt.lastProvider;
  const effectiveModel = attempt.lastModel;
  // If failover ran the request against a different model, surface that
  // on the response so the caller's logging shows what actually executed.
  if (effectiveModel !== body.model) {
    body.model = effectiveModel;
  }

  // ---- Compute cost & log ----------------------------------------------
  const totalLatency = Date.now() - start;
  const costMicroCents = calcCostMicroCents(
    effectiveProvider,
    effectiveModel,
    result.inputTokens,
    result.outputTokens,
    result.cachedInputTokens
  );
  const costCents = microCentsToCents(costMicroCents);
  const cacheSavings = calcCacheSavingsMicroCents(
    effectiveProvider,
    effectiveModel,
    result.cachedInputTokens
  );
  const originalProvider = recordedOriginalModel
    ? (findProviderTemplate(recordedOriginalModel)?.name ?? null)
    : null;
  const routingSaving = calcRoutingSavingMicroCents(
    originalProvider,
    recordedOriginalModel,
    effectiveModel,
    result.inputTokens,
    result.outputTokens,
    result.cachedInputTokens,
    costMicroCents
  );
  stampResponseToolCallTags(tags, result.body, "response");
  // Reprice the compressor's saved input tokens at the model that
  // actually executed (failover may have swapped it). No-op when
  // the compressor didn't fire on this request.
  stampToolCompressMicroCentsSaved(tags, effectiveProvider, effectiveModel);

  const record: InsertRequest = {
    project_id: apiKey.project_id,
    api_key_id: apiKey.id,
    provider: effectiveProvider,
    model: effectiveModel,
    input_tokens: result.inputTokens,
    cached_input_tokens: result.cachedInputTokens,
    output_tokens: result.outputTokens,
    cost_cents: costCents,
    cost_micro_cents: costMicroCents,
    cache_savings_micro_cents: cacheSavings,
    routing_saving_micro_cents: routingSaving,
    latency_ms: totalLatency,
    status: result.status >= 200 && result.status < 300 ? "success" : "error",
    error: result.status >= 400 ? "Upstream returned non-2xx" : null,
    fingerprint,
    original_model: recordedOriginalModel,
    streamed: false,
    request_body: body,
    response_body: result.body,
    tags,
  };

  const inserted = await insertRequest({
    ...record,
    id: requestId,
    routing_reason: routingReason,
    routing_bucket: routingBucket,
  }).catch((e) => {
    console.error("Failed to insert request:", e);
    return null;
  });
  if (inserted && compressedBlobEntries.length > 0) {
    await storeCompressedBlobs(
      apiKey.project_id,
      requestId,
      compressedBlobEntries
    ).catch((e) =>
      console.warn(
        `[context-compress] blob store failed for ${requestId}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    );
  }
  await releaseReservedBudget();

  // OTel: one span per request. The dashboard request-detail URL is the
  // canonical "drill in" link; we attach it as `tokensmart.request_url` so
  // a Langfuse / Datadog trace view links straight back to the request page.
  recordSpan({
    traceId,
    spanId,
    name: "chat.completions",
    kind: "server",
    startTimeMs: start,
    endTimeMs: start + totalLatency,
    status: record.status === "success" ? "ok" : "error",
    errorMessage: record.error ?? undefined,
    attributes: {
      "tokensmart.project_id": apiKey.project_id,
      "tokensmart.request_id": inserted?.id ?? null,
      "tokensmart.original_model": recordedOriginalModel,
      "tokensmart.routed": recordedOriginalModel != null,
      "tokensmart.streamed": false,
      "tokensmart.cost_micro_cents": costMicroCents,
      "tokensmart.routing_saving_micro_cents": routingSaving,
      "tokensmart.cache_savings_micro_cents": cacheSavings,
      "gen_ai.system": effectiveProvider,
      "gen_ai.request.model": effectiveModel,
      "gen_ai.response.model": effectiveModel,
      "gen_ai.usage.input_tokens": result.inputTokens,
      "gen_ai.usage.output_tokens": result.outputTokens,
      "gen_ai.usage.cached_tokens": result.cachedInputTokens,
      "http.response.status_code": result.status,
    },
  });

  // ---- Persist to semantic cache (best-effort) -------------------------
  // Only on a clean 2xx upstream — we never cache failed responses.
  if (
    cacheLookup &&
    !cacheLookup.hit &&
    cacheLookup.cacheKey &&
    record.status === "success"
  ) {
    storeInSemanticCache({
      projectId: apiKey.project_id,
      cacheKey: cacheLookup.cacheKey,
      body,
      responseBody: result.body,
    }).catch(() => {
      /* best-effort; logged inside */
    });
  }

  if (shadowModel && record.status === "success") {
    dispatchShadow({
      projectId: apiKey.project_id,
      userId: apiKey.project_user_id,
      fingerprint,
      primaryRequestId: inserted?.id ?? null,
      primaryModel: effectiveModel,
      primaryProvider: effectiveProvider,
      primaryInputTokens: result.inputTokens,
      primaryOutputTokens: result.outputTokens,
      primaryCachedInputTokens: result.cachedInputTokens,
      primaryCostMicroCents: costMicroCents,
      primaryLatencyMs: totalLatency,
      shadowModel,
      body: bodySnapshot,
      // Pass the primary response so the shadow path can embed both and
      // record similarity. Streaming branch passes nothing — we don't keep
      // the full text there.
      primaryResponseBody: result.body,
    });
  }

  applyRoutingDecisionHeaders(c, {
    askedModel: originalModel,
    landedModel: effectiveModel,
    routingReason: routingReason,
    costMicroCents: costMicroCents,
    costSavedVsAskedMicroCents: routingSaving,
    ...readToolCompressFromTags(tags),
  });
  return c.json(result.body, result.status as 200);
});
