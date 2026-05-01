import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import {
  getAlertRuleById,
  getProjectPlan,
  insertRequest,
  sql,
  type InsertRequest,
} from "../db";
import { resolveProvider } from "../provider-resolve";
import {
  callUpstream,
  type OpenAIChatRequest,
} from "../providers/openai";
import { callAnthropic } from "../providers/anthropic";
import {
  calcCacheSavingsMicroCents,
  calcCostMicroCents,
  microCentsToCents,
} from "../pricing";
import { findProviderTemplate } from "../config";
import { fingerprintRequest } from "../fingerprint";
import { runAlertTest } from "../alerts";

export const internalRoutes = new Hono();

function internalTokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Internal endpoints (`/internal/replay`, `/internal/test-alert`) are
 * disabled-by-default. Operator must opt in by setting
 * `TOKENSMART_INTERNAL_REPLAY_ENABLED=1` AND
 * `TOKENSMART_INTERNAL_TOKEN`. The flag name is historical (replay was
 * the first endpoint in this file); it gates the entire `/internal/*`
 * surface.
 */
function internalEndpointsEnabled(): boolean {
  return process.env.TOKENSMART_INTERNAL_REPLAY_ENABLED === "1";
}

const INTERNAL_BODY_LIMIT_BYTES = 1_000_000; // 1 MB cap per call

async function readJsonWithLimit(c: { req: { raw: Request } }): Promise<unknown> {
  const text = await c.req.raw.text();
  if (text.length > INTERNAL_BODY_LIMIT_BYTES) {
    throw new Error(
      `Body exceeds ${INTERNAL_BODY_LIMIT_BYTES}-byte cap on internal endpoints.`
    );
  }
  return JSON.parse(text);
}

/**
 * Trusted-server-only endpoint. Lets the dashboard re-issue an existing
 * request body against a (possibly different) model and record the result
 * in the same `requests` ledger. Bypasses API-key auth — instead requires
 * a shared secret in `x-tokensmart-internal-token` matching
 * `TOKENSMART_INTERNAL_TOKEN`. Disabled (returns 503) unless BOTH
 * `TOKENSMART_INTERNAL_REPLAY_ENABLED=1` and the shared token are set, so a
 * stock self-host install doesn't accidentally expose it.
 *
 * Why bypass API-key auth: the dashboard typically doesn't have any
 * customer's plaintext key (we hash on issue), so we can't pretend to be
 * one of their keys. Internal token is the simplest safe alternative; the
 * caller is the dashboard process running on the same trust boundary as
 * the gateway (they're already deployed together via docker-compose.prod).
 *
 * Pipeline (slimmed vs /v1/chat/completions):
 *   - Skip auth (internal token verified above)
 *   - Skip loop detection (replays are explicit user actions, not loops)
 *   - Skip plan-cap enforcement (replay is operator-driven; counting it
 *     against the user's daily cap creates a "your replay button cost
 *     you a request" footgun on tight plans)
 *   - DO run provider resolution (BYO keys still apply)
 *   - DO write a `requests` row with `tags.replay_of=<orig_id>` so the
 *     dashboard can surface "this row was a manual replay"
 *
 * Request body:
 *   {
 *     project_id: uuid,
 *     model: string,        // the model to run against (may differ from original)
 *     body: OpenAIChatRequest,  // the original request body, possibly with model swapped
 *     replay_of_request_id: uuid,  // for tagging
 *   }
 *
 * Response: { ok: true, request_id: uuid, status: number } on success,
 *           { ok: false, error: string } on failure (caller decides toast).
 */
internalRoutes.post("/internal/replay", async (c) => {
  if (!internalEndpointsEnabled()) {
    return c.json(
      {
        ok: false,
        error:
          "Internal endpoints disabled. Set TOKENSMART_INTERNAL_REPLAY_ENABLED=1 on the gateway to enable.",
      },
      503
    );
  }
  const expectedToken = process.env.TOKENSMART_INTERNAL_TOKEN;
  if (!expectedToken) {
    return c.json(
      {
        ok: false,
        error:
          "Internal endpoints disabled. Set TOKENSMART_INTERNAL_TOKEN on the gateway and dashboard to enable.",
      },
      503
    );
  }
  const presented = c.req.header("x-tokensmart-internal-token") ?? "";
  if (!internalTokenMatches(presented, expectedToken)) {
    return c.json({ ok: false, error: "Invalid internal token" }, 401);
  }

  let payload: {
    project_id?: string;
    model?: string;
    body?: OpenAIChatRequest;
    replay_of_request_id?: string;
  };
  try {
    payload = (await readJsonWithLimit(c)) as typeof payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Body must be valid JSON";
    return c.json({ ok: false, error: msg }, 400);
  }
  const { project_id, model, body, replay_of_request_id } = payload;
  if (
    !project_id ||
    !model ||
    !body ||
    typeof body !== "object" ||
    !Array.isArray(body.messages) ||
    !replay_of_request_id
  ) {
    return c.json(
      {
        ok: false,
        error:
          "Missing fields. Required: project_id, model, body{messages[]}, replay_of_request_id.",
      },
      400
    );
  }

  const sourceRows = await sql<Array<{ project_id: string | null }>>`
    SELECT project_id FROM requests WHERE id = ${replay_of_request_id} LIMIT 1
  `;
  const sourceProjectId = sourceRows[0]?.project_id ?? null;
  if (!sourceProjectId || sourceProjectId !== project_id) {
    return c.json(
      { ok: false, error: "Replay source request was not found for this project." },
      404
    );
  }

  // Ensure the project exists + grab the owning user (for BYO key lookup).
  const planCtx = await getProjectPlan(project_id);
  const userId = planCtx?.user_id ?? null;

  // Force the requested model onto the body (the caller may have chosen a
  // different one than the original).
  const replayBody: OpenAIChatRequest = { ...body, model };
  // Strip streaming — replay is request/response, never SSE. Even if the
  // original was streamed, the replay should produce a complete row.
  delete (replayBody as { stream?: unknown }).stream;
  delete (replayBody as { stream_options?: unknown }).stream_options;

  // Provider resolution — honor BYO keys for the chosen model.
  const resolved = await resolveProvider(userId, model);
  if (!resolved.ok) {
    return c.json(
      {
        ok: false,
        error:
          resolved.reason === "no_template"
            ? `Unrecognized model '${model}'. Provider catalog has no match.`
            : `No credentials for ${resolved.providerName ?? "?"} (model '${model}').`,
      },
      400
    );
  }
  const providerCfg = resolved.config;

  const fingerprint = fingerprintRequest(project_id, replayBody);
  const start = Date.now();
  const upstreamCall =
    providerCfg.name === "anthropic" ? callAnthropic : callUpstream;

  let result: Awaited<ReturnType<typeof upstreamCall>>;
  try {
    result = await upstreamCall(replayBody, providerCfg);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failed: InsertRequest = {
      project_id,
      api_key_id: null,
      provider: providerCfg.name,
      model,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      cost_micro_cents: 0,
      cache_savings_micro_cents: 0,
      latency_ms: Date.now() - start,
      status: "error",
      error: `replay: ${detail}`,
      fingerprint,
      original_model: null,
      streamed: false,
      request_body: replayBody,
      response_body: null,
      tags: {
        replay_of: replay_of_request_id,
        replay_kind: "manual",
      },
    };
    const inserted = await insertRequest(failed).catch(() => null);
    return c.json({ ok: false, error: detail, request_id: inserted?.id ?? null }, 502);
  }

  const cost = calcCostMicroCents(
    providerCfg.name,
    model,
    result.inputTokens,
    result.outputTokens,
    result.cachedInputTokens
  );
  const cacheSavings = calcCacheSavingsMicroCents(
    providerCfg.name,
    model,
    result.cachedInputTokens
  );

  const row: InsertRequest = {
    project_id,
    api_key_id: null,
    provider: providerCfg.name,
    model,
    input_tokens: result.inputTokens,
    cached_input_tokens: result.cachedInputTokens,
    output_tokens: result.outputTokens,
    cost_cents: microCentsToCents(cost),
    cost_micro_cents: cost,
    cache_savings_micro_cents: cacheSavings,
    latency_ms: Date.now() - start,
    status: result.status >= 200 && result.status < 300 ? "success" : "error",
    error: result.status >= 400 ? "Upstream returned non-2xx" : null,
    fingerprint,
    original_model: null,
    streamed: false,
    request_body: replayBody,
    response_body: result.body,
    tags: {
      replay_of: replay_of_request_id,
      replay_kind: "manual",
    },
  };
  const inserted = await insertRequest(row).catch((e) => {
    console.error("[replay] insert failed:", e);
    return null;
  });

  // Avoid unused-import warnings — `findProviderTemplate` and `sql` are
  // imported for potential future expansion (e.g. per-tenant rate limits).
  void findProviderTemplate;
  void sql;

  return c.json(
    {
      ok: true,
      request_id: inserted?.id ?? null,
      status: result.status,
      provider: providerCfg.name,
      model,
      cost_micro_cents: cost,
      latency_ms: row.latency_ms,
    },
    200
  );
});

/**
 * Trusted-server-only endpoint. Lets the dashboard fire a TEST payload
 * against an existing alert rule's webhook AND email targets — through
 * the gateway's own delivery code so behavior matches production.
 *
 * Auth: same TOKENSMART_INTERNAL_TOKEN gate as /internal/replay.
 *
 * Why this lives in the gateway (not the dashboard):
 *   - Single source of truth for the alert envelope shape.
 *   - Email goes through `RESEND_API_KEY` which is a gateway-side secret
 *     (the dashboard's RESEND_API_KEY is for OTP login, may be different
 *     in self-host setups).
 *   - Webhook tests get the same User-Agent + X-TokenSmart-Event headers
 *     that real alerts send, so an operator's signature-verification
 *     middleware sees identical traffic.
 *
 * Request body:
 *   { project_id: uuid, rule_id: uuid }
 *
 * Response:
 *   {
 *     ok: boolean,                    // true iff every attempted channel succeeded
 *     webhook: { attempted, ok, status?, error?, ... },
 *     email:   { attempted, ok, status?, error?, skipped?, ... }
 *   }
 *
 * `ok` aggregates: true when every channel that was attempted returned ok.
 * If neither channel was configured on the rule, returns 400.
 */
internalRoutes.post("/internal/test-alert", async (c) => {
  if (!internalEndpointsEnabled()) {
    return c.json(
      {
        ok: false,
        error:
          "Internal endpoints disabled. Set TOKENSMART_INTERNAL_REPLAY_ENABLED=1 on the gateway to enable.",
      },
      503
    );
  }
  const expectedToken = process.env.TOKENSMART_INTERNAL_TOKEN;
  if (!expectedToken) {
    return c.json(
      {
        ok: false,
        error:
          "Internal endpoints disabled. Set TOKENSMART_INTERNAL_TOKEN on the gateway and dashboard to enable.",
      },
      503
    );
  }
  const presented = c.req.header("x-tokensmart-internal-token") ?? "";
  if (!internalTokenMatches(presented, expectedToken)) {
    return c.json({ ok: false, error: "Invalid internal token" }, 401);
  }

  let payload: { project_id?: string; rule_id?: string };
  try {
    payload = (await readJsonWithLimit(c)) as typeof payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Body must be valid JSON";
    return c.json({ ok: false, error: msg }, 400);
  }
  const { project_id, rule_id } = payload;
  if (!project_id || !rule_id) {
    return c.json(
      { ok: false, error: "Missing fields. Required: project_id, rule_id." },
      400
    );
  }

  const rule = await getAlertRuleById(rule_id, project_id);
  if (!rule) {
    return c.json({ ok: false, error: "Alert rule not found." }, 404);
  }
  if (!rule.webhook_url && !rule.email) {
    return c.json(
      {
        ok: false,
        error: "Rule has neither a webhook URL nor an email target.",
      },
      400
    );
  }

  const result = await runAlertTest(
    rule,
    "This is a TEST alert dispatched from the TokSuan dashboard. No real event occurred."
  );

  // Aggregate `ok` across attempted channels so the dashboard can render
  // a single success/failure pill without re-implementing the rollup.
  const attempted = [result.webhook, result.email].filter(
    (r) => r.attempted
  ) as Array<Extract<typeof result.webhook, { attempted: true }>>;
  const ok = attempted.length > 0 && attempted.every((r) => r.ok);

  return c.json({ ok, webhook: result.webhook, email: result.email }, 200);
});
