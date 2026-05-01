import { callUpstream, type OpenAIChatRequest } from "./providers/openai";
import { callAnthropic } from "./providers/anthropic";
import { calcCostMicroCents } from "./pricing";
import { resolveProvider } from "./provider-resolve";
import { insertAbResult, type AbResultInsert } from "./db";
import { computeResponseSimilarity, extractResponseText } from "./quality";

/**
 * Fire-and-forget A/B shadow request.
 *
 * Spawns a parallel call to the experimental model AFTER the primary has
 * completed (so the user-facing latency is untouched), then writes a row to
 * `ab_results` for later analysis. Failures are logged, not surfaced — a
 * misbehaving shadow target must never affect the primary request.
 *
 * The shadow body is a clone of the original WITHOUT `stream` (we never want
 * to stream a measurement-only call) and with `n=1` even if the primary
 * asked for multiple completions.
 */

export type ShadowParams = {
  projectId: string;
  /**
   * Owning user of the project, when known. Lets shadow calls reuse the
   * customer's BYO upstream-provider key — important so a shadow call to
   * Claude doesn't fail just because the gateway's env only has OpenAI.
   */
  userId: string | null;
  fingerprint: string | null;
  primaryRequestId: string | null;
  primaryModel: string;
  primaryProvider: string;
  primaryInputTokens: number;
  primaryOutputTokens: number;
  primaryCachedInputTokens: number;
  primaryCostMicroCents: number;
  primaryLatencyMs: number | null;
  shadowModel: string;
  body: OpenAIChatRequest;
  /**
   * The primary response body (OpenAI ChatCompletion shape). When present
   * and quality embedding is enabled, we'll embed both primary and shadow
   * response text and store the cosine similarity on the ab_results row.
   * Streaming requests pass null — we don't keep the full text in that path.
   */
  primaryResponseBody?: unknown;
};

export function dispatchShadow(params: ShadowParams): void {
  const shadowBody: OpenAIChatRequest = {
    ...params.body,
    model: params.shadowModel,
  };
  // Strip streaming + multi-completion from the shadow path.
  delete (shadowBody as { stream?: unknown }).stream;
  delete (shadowBody as { stream_options?: unknown }).stream_options;
  if ("n" in shadowBody) shadowBody.n = 1;

  (async () => {
    const resolved = await resolveProvider(params.userId, params.shadowModel);
    if (!resolved.ok) {
      console.warn(
        `[shadow] no credentials for shadow model '${params.shadowModel}' (${resolved.reason}), skipping`
      );
      return;
    }
    const provider = resolved.config;
    const upstreamCall =
      provider.name === "anthropic" ? callAnthropic : callUpstream;

    const start = Date.now();
    let result: Awaited<ReturnType<typeof upstreamCall>>;
    let err: string | null = null;
    try {
      result = await upstreamCall(shadowBody, provider);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      const failed: AbResultInsert = {
        project_id: params.projectId,
        primary_request_id: params.primaryRequestId,
        primary_model: params.primaryModel,
        primary_provider: params.primaryProvider,
        primary_input_tokens: params.primaryInputTokens,
        primary_output_tokens: params.primaryOutputTokens,
        primary_cost_micro_cents: params.primaryCostMicroCents,
        primary_latency_ms: params.primaryLatencyMs,
        shadow_model: params.shadowModel,
        shadow_provider: provider.name,
        shadow_input_tokens: 0,
        shadow_output_tokens: 0,
        shadow_cost_micro_cents: 0,
        shadow_latency_ms: Date.now() - start,
        shadow_status: "error",
        shadow_response_body: null,
        shadow_error: err,
        fingerprint: params.fingerprint,
      };
      await insertAbResult(failed).catch((e) =>
        console.error("[shadow] ab_results insert failed:", e)
      );
      return;
    }

    const shadowCost = calcCostMicroCents(
      provider.name,
      params.shadowModel,
      result.inputTokens,
      result.outputTokens,
      result.cachedInputTokens
    );
    const status: "success" | "error" =
      result.status >= 200 && result.status < 300 ? "success" : "error";

    // Embed primary + shadow response text and compute cosine similarity.
    // Best-effort — null if disabled, errored, or either text is empty.
    // Adds one round-trip to the embedding model (~$0.0002), well after
    // the user has received their primary response.
    let similarity: number | null = null;
    if (status === "success" && params.primaryResponseBody) {
      const primaryText = extractResponseText(params.primaryResponseBody);
      const shadowText = extractResponseText(result.body);
      if (primaryText && shadowText) {
        similarity = await computeResponseSimilarity(primaryText, shadowText);
      }
    }

    const row: AbResultInsert = {
      project_id: params.projectId,
      primary_request_id: params.primaryRequestId,
      primary_model: params.primaryModel,
      primary_provider: params.primaryProvider,
      primary_input_tokens: params.primaryInputTokens,
      primary_output_tokens: params.primaryOutputTokens,
      primary_cost_micro_cents: params.primaryCostMicroCents,
      primary_latency_ms: params.primaryLatencyMs,
      shadow_model: params.shadowModel,
      shadow_provider: provider.name,
      shadow_input_tokens: result.inputTokens,
      shadow_output_tokens: result.outputTokens,
      shadow_cost_micro_cents: shadowCost,
      shadow_latency_ms: Date.now() - start,
      shadow_status: status,
      shadow_response_body: result.body,
      shadow_error:
        status === "error" ? "Upstream returned non-2xx for shadow" : null,
      fingerprint: params.fingerprint,
      similarity,
    };
    await insertAbResult(row).catch((e) =>
      console.error("[shadow] ab_results insert failed:", e)
    );
  })().catch((e) => console.error("[shadow] dispatch crashed:", e));
}
