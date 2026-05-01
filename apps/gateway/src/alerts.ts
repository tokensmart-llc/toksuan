import { getAlertRules, type AlertEventType, type AlertRule } from "./db";
import { isPublicEgressUrlAllowed } from "./url-allowlist";

export type AlertPayload = {
  event: AlertEventType;
  project_id: string;
  timestamp: string;
  details: Record<string, unknown>;
};

const WEBHOOK_TIMEOUT_MS = 5000;
const EMAIL_TIMEOUT_MS = 10_000;

/** Whether RESEND_API_KEY is set on this gateway process. Used by the
 * /health endpoint so the dashboard can show "Email delivery: enabled
 * (Resend)" vs "log-only" without the dashboard having to also know
 * RESEND_API_KEY (it lives only on the gateway). */
export function isAlertEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.length > 0);
}

/** Resend-side from address the gateway will use. Exposed for /health so
 * the dashboard can preview "alerts will be sent from <…>". Never the
 * API key itself. */
export function getAlertEmailFrom(): string | null {
  if (!isAlertEmailConfigured()) return null;
  return process.env.RESEND_FROM ?? "TokSuan <alerts@resend.dev>";
}

/**
 * Fire-and-forget alert dispatch. Returns immediately; deliveries run in the
 * background. The request path must NEVER block or fail because a webhook
 * timed out or the inbox is down.
 *
 * Returns a Promise (no longer void) so the retrain CLI — which is allowed
 * to block before exiting — can `await dispatchAlert(...)` to ensure the
 * webhook/email actually got out the door before the process dies. Request-
 * path callers continue to fire-and-forget; that contract is unchanged.
 */
export function dispatchAlert(
  projectId: string,
  event: AlertEventType,
  details: Record<string, unknown>
): Promise<void> {
  const payload: AlertPayload = {
    event,
    project_id: projectId,
    timestamp: new Date().toISOString(),
    details,
  };

  const work = (async () => {
    let rules;
    try {
      rules = await getAlertRules(projectId, event);
    } catch (err) {
      console.error(`[alerts] failed to load rules for ${event}:`, err);
      return;
    }
    if (rules.length === 0) return;

    await Promise.all(
      rules.map(async (rule) => {
        if (rule.webhook_url) await deliverWebhook(rule.webhook_url, payload);
        if (rule.email) await deliverEmail(rule.email, payload);
      })
    );
  })().catch((err) => {
    console.error("[alerts] dispatch crashed:", err);
  });
  return work;
}

async function deliverWebhook(url: string, payload: AlertPayload): Promise<void> {
  const result = await deliverWebhookWithResult(url, payload);
  if (!result.ok) {
    console.warn(`[alerts] webhook ${url} → ${result.error}`);
  }
}

/**
 * Same wire format as `deliverWebhook` but returns a structured result
 * instead of swallowing into console.warn. Used by the test endpoint so
 * the dashboard can render "webhook returned HTTP 404" instead of just
 * "test failed". The fire-and-forget production path keeps using
 * `deliverWebhook` so a slow/failing webhook never propagates back to
 * the request path.
 */
async function deliverWebhookWithResult(
  url: string,
  payload: AlertPayload
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!isPublicEgressUrlAllowed(url)) {
    return {
      ok: false,
      error:
        "Webhook URL is not a public HTTPS endpoint. Use a public https:// URL or set TOKENSMART_ALLOW_PRIVATE_PROVIDER_URLS=1 for self-hosted/private-network deployments.",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "TokSuan/0.0.1 (+https://tokensmt.com)",
        "X-TokenSmart-Event": payload.event,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send an alert email via Resend's HTTP API.
 *
 * Why Resend + plain fetch (no SDK): the gateway deliberately keeps a
 * tiny dependency list (5 packages today). Adding the `resend` SDK
 * for one POST call doubles the install surface for marginal value.
 * The Resend REST API is one endpoint with a JSON body — easier to
 * audit, easier to mock in tests.
 *
 * Why this is a method on the gateway and not a delegation to the
 * dashboard: alerts originate in request paths the dashboard never
 * sees (the gateway-process budget enforcement, the cron-process
 * retrain failure). Cross-app HTTP would just add a failure mode
 * for a feature that's already at-most-once-best-effort.
 *
 * Falls back to a stdout log when RESEND_API_KEY is unset, so
 * self-hosted operators get the same visibility they had before
 * without provisioning email.
 */
async function deliverEmail(to: string, payload: AlertPayload): Promise<void> {
  const result = await deliverEmailWithResult(to, payload);
  if (result.skipped) {
    console.log(
      `[alerts] email → ${to} (${payload.event}) — RESEND_API_KEY unset, logging only:\n` +
        JSON.stringify(payload, null, 2)
    );
    return;
  }
  if (!result.ok) {
    console.warn(
      `[alerts] email → ${to} (${payload.event}) — ${result.error ?? "unknown error"}`
    );
    return;
  }
  console.log(`[alerts] email → ${to} (${payload.event}) sent`);
}

/**
 * Same wire format as `deliverEmail` but returns a structured result
 * (and reports the no-RESEND_API_KEY case explicitly via `skipped: true`).
 * Used by the test endpoint so the dashboard can render exactly why
 * email did or did not go out — including "Email is in log-only mode on
 * the gateway because RESEND_API_KEY isn't set", which is the
 * actionable thing for an operator to fix.
 */
async function deliverEmailWithResult(
  to: string,
  payload: AlertPayload
): Promise<{ ok: boolean; skipped?: boolean; status?: number; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      skipped: true,
      error: "RESEND_API_KEY is not set on the gateway",
    };
  }

  const from = process.env.RESEND_FROM ?? "TokSuan <alerts@resend.dev>";
  const subject = formatAlertSubject(payload);
  const body = formatAlertBody(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text: body,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "<unreadable>");
      return {
        ok: false,
        status: res.status,
        error: `Resend HTTP ${res.status}: ${errBody.slice(0, 200)}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Per-event subject line. Front-loads the most actionable token so a
 * Gmail thread list shows the right thing.
 */
function formatAlertSubject(payload: AlertPayload): string {
  switch (payload.event) {
    case "budget_exceeded":
      return `[TokSuan] budget exceeded — project ${shortId(payload.project_id)}`;
    case "loop_detected":
      return `[TokSuan] agent loop blocked — project ${shortId(payload.project_id)}`;
    case "cost_anomaly":
      return `[TokSuan] cost anomaly — project ${shortId(payload.project_id)}`;
    case "retrain_failed":
      return `[TokSuan] nightly retrain FAILED — project ${shortId(payload.project_id)}`;
  }
}

function formatAlertBody(payload: AlertPayload): string {
  const detailLines = Object.entries(payload.details)
    .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return [
    `TokSuan alert: ${payload.event}`,
    "",
    `project_id: ${payload.project_id}`,
    `time:       ${payload.timestamp}`,
    "",
    "details:",
    detailLines || "  (none)",
    "",
    "—",
    "This is an automated alert from your TokSuan deployment.",
    "Manage subscriptions at /projects/<id> → Alert subscriptions.",
  ].join("\n");
}

function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

export type AlertTestChannelResult =
  | { attempted: true; ok: true; status?: number }
  | { attempted: true; ok: false; status?: number; error: string; skipped?: boolean }
  | { attempted: false };

export type AlertTestResult = {
  webhook: AlertTestChannelResult;
  email: AlertTestChannelResult;
};

/**
 * Synchronous (await-able) test dispatch for a single alert rule.
 *
 * Differs from `dispatchAlert` in three ways:
 *   1. Returns per-channel result (so a UI can show "webhook OK, email
 *      failed: HTTP 422").
 *   2. Marks the payload `details.test = true` and `details.note = "..."`
 *      so the receiving system / inbox can clearly distinguish a test
 *      from a real event.
 *   3. Doesn't read `getAlertRules` — caller passes the rule it already
 *      loaded (used by `/internal/test-alert` after `getAlertRuleById`
 *      verified ownership).
 *
 * Both channels are attempted in parallel — same as production dispatch.
 */
export async function runAlertTest(
  rule: AlertRule,
  testNote: string
): Promise<AlertTestResult> {
  const payload: AlertPayload = {
    event: rule.event_type,
    project_id: rule.project_id,
    timestamp: new Date().toISOString(),
    details: {
      test: true,
      note: testNote,
      ...sampleDetailsFor(rule.event_type),
    },
  };

  const [webhookRes, emailRes] = await Promise.all([
    rule.webhook_url
      ? deliverWebhookWithResult(rule.webhook_url, payload).then(
          (r): AlertTestChannelResult => ({
            attempted: true,
            ...r,
            error: r.ok ? undefined : (r.error ?? "unknown error"),
          } as AlertTestChannelResult)
        )
      : Promise.resolve<AlertTestChannelResult>({ attempted: false }),
    rule.email
      ? deliverEmailWithResult(rule.email, payload).then(
          (r): AlertTestChannelResult => ({
            attempted: true,
            ...r,
            error: r.ok ? undefined : (r.error ?? "unknown error"),
          } as AlertTestChannelResult)
        )
      : Promise.resolve<AlertTestChannelResult>({ attempted: false }),
  ]);

  return { webhook: webhookRes, email: emailRes };
}

/**
 * Per-event-type sample `details` block for test dispatches. Mirrors what
 * the dashboard's `sampleMetadataFor` produces — kept in sync because a
 * real payload's `details` shape is whatever the `dispatchAlert` caller
 * stamped at the call site (see `chat.ts` / `monitor.ts` / retrain CLI).
 */
function sampleDetailsFor(eventType: AlertEventType): Record<string, unknown> {
  switch (eventType) {
    case "budget_exceeded":
      return {
        period: "daily",
        spend_micro_cents: 12_345,
        limit_micro_cents: 10_000,
      };
    case "loop_detected":
      return {
        fingerprint: "test_fp_abcdef1234",
        attempts_in_window: 12,
        window_minutes: 5,
      };
    case "cost_anomaly":
      return {
        z_score: 4.2,
        baseline_hourly_micro_cents: 1500,
        observed_hourly_micro_cents: 9800,
      };
    case "retrain_failed":
      return {
        tag: null,
        reason: "transaction failed: simulated test failure",
        source: "manual",
        lookback_days: 7,
        prior_strength: 20,
      };
  }
}
