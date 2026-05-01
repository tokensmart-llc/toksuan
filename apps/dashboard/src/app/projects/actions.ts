"use server";

import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ALERT_EVENT_TYPES,
  createAlertRule,
  createApiKey,
  createProject,
  deleteAlertRule,
  deleteApiKey,
  deleteBudget,
  deleteProject,
  deleteRoutingRule,
  getAlertRuleById,
  getProjectForUser,
  previewRoutingMatch,
  rotateApiKey,
  upsertBudget,
  upsertRoutingRule,
  type AlertEventType,
  type BudgetPeriod,
  type RoutingMatchPreview,
  type RoutingMode,
} from "@/lib/db";
import { getSession } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";

async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

function generateApiKey(): { raw: string; hash: string } {
  // `ts_` brand prefix + 32 bytes of entropy. We hand the raw value back to
  // the user exactly ONCE; the DB only persists the SHA-256 hash + display
  // fragments.
  const raw = `ts_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function toastQuery(
  slug: string,
  args?: Record<string, string | undefined>
): string {
  const params = new URLSearchParams({ toast: slug });
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      if (v != null) params.set(k, v);
    }
  }
  return params.toString();
}

const REVEAL_COOKIE = "tokensmart_reveal";
const REVEAL_TTL_SECONDS = 120;

/**
 * Stash a freshly-minted plaintext key in a short-lived HTTP-only cookie so
 * the project page can render it once. The cookie is consumed on read so
 * refreshing the page clears it; this keeps secrets out of the URL bar +
 * browser history.
 */
async function stashRevealKey(value: string): Promise<void> {
  const store = await cookies();
  store.set(REVEAL_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: REVEAL_TTL_SECONDS,
  });
}

async function actorContext() {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null;
  const ua = h.get("user-agent");
  return { ip, ua };
}

export async function createProjectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const project = await createProject(session.user.id, name);

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: "project.created",
    targetType: "project",
    targetId: project.id,
    metadata: { name: project.name },
    ip,
    userAgent: ua,
  });
  redirect(
    `/projects/${project.id}?${toastQuery("project-created", { toast_arg: project.name })}`
  );
}

export async function deleteProjectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("project_id") ?? "");
  const project = await getProjectForUser(session.user.id, projectId);
  if (!project) return;

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: "project.deleted",
    targetType: "project",
    targetId: project.id,
    metadata: { name: project.name },
    ip,
    userAgent: ua,
  });

  await deleteProject(project.id, session.user.id);
  redirect(
    `/projects?${toastQuery("project-deleted", { toast_arg: project.name })}`
  );
}

export async function createApiKeyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("project_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const project = await getProjectForUser(session.user.id, projectId);
  if (!project) return;
  if (!name) {
    redirect(
      `/projects/${project.id}?${toastQuery("key-name-required")}#api-keys`
    );
  }
  const { raw, hash } = generateApiKey();
  let key: Awaited<ReturnType<typeof createApiKey>>;
  try {
    key = await createApiKey(project.id, name, raw, hash);
  } catch (err) {
    console.error("[projects] createApiKeyAction insert failed:", err);
    redirect(`/projects/${project.id}?${toastQuery("key-create-failed")}#api-keys`);
  }

  try {
    await stashRevealKey(raw);
  } catch (err) {
    console.error("[projects] createApiKeyAction reveal-cookie failed:", err);
    redirect(`/projects/${project.id}?${toastQuery("key-created-no-reveal")}#api-keys`);
  }

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: "api_key.created",
    targetType: "api_key",
    targetId: key.id,
    metadata: { name: key.name, prefix: key.key_prefix, last4: key.key_last4 },
    ip,
    userAgent: ua,
  });
  redirect(`/projects/${project.id}#api-keys`);
}

export async function deleteApiKeyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("project_id") ?? "");
  const keyId = String(formData.get("key_id") ?? "");
  const project = await getProjectForUser(session.user.id, projectId);
  if (!project) return;
  await deleteApiKey(keyId, project.id);

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: "api_key.deleted",
    targetType: "api_key",
    targetId: keyId,
    ip,
    userAgent: ua,
  });

  redirect(`/projects/${project.id}?${toastQuery("key-deleted")}#api-keys`);
}

/**
 * One-click rotate: atomically mints a replacement key with the same
 * `name` and deletes the old one. The new plaintext is stashed in the
 * one-time reveal cookie so the project page shows it exactly once.
 *
 * Cutover is immediate — the old key stops working the moment the
 * transaction commits. Copy the new key from the reveal banner BEFORE
 * updating your deployment. For a soft grace period we'd need
 * `api_keys.expires_at`; see the `rotateApiKey` doc-comment in db.ts.
 */
export async function rotateApiKeyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("project_id") ?? "");
  const oldKeyId = String(formData.get("key_id") ?? "");
  const project = await getProjectForUser(session.user.id, projectId);
  if (!project) return;

  const { raw, hash } = generateApiKey();
  const result = await rotateApiKey({
    oldId: oldKeyId,
    projectId: project.id,
    newRawKey: raw,
    newKeyHash: hash,
    // 24h default grace — long enough for a rolling deploy, short
    // enough that operators don't forget an old key is still live.
    // Can be overridden by passing graceMs=0 for an immediate-cutover
    // (compromised key) rotation; that path isn't wired to the UI yet,
    // but the DB helper supports it.
  });
  if (!result) {
    redirect(`/projects/${project.id}?${toastQuery("key-rotate-not-found")}#api-keys`);
  }
  await stashRevealKey(raw);

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: "api_key.rotated",
    targetType: "api_key",
    targetId: result.newKey.id,
    metadata: {
      old_key_id: oldKeyId,
      name: result.newKey.name,
      prefix: result.newKey.key_prefix,
      last4: result.newKey.key_last4,
      old_expires_at: result.oldExpiresAt?.toISOString() ?? null,
    },
    ip,
    userAgent: ua,
  });

  redirect(`/projects/${project.id}?${toastQuery("key-rotated")}#api-keys`);
}

/**
 * READ-ONLY helper. Used by the project page during render to fetch the
 * freshly-minted plaintext key for one-time display. Does NOT delete the
 * cookie — Next 15 forbids cookie mutations during render-phase
 * `cookies()` calls (`Cookies can only be modified in a Server Action
 * or Route Handler`). Active deletion is the job of `dismissRevealedKey`,
 * called from a client component effect after the panel mounts.
 *
 * Why split read from delete:
 *   The previous unified `consumeRevealedKey` worked under Next 14 because
 *   the render-phase cookie store was mutable. Next 15 made it read-only
 *   to prevent a class of "double-render mutates cookie twice" bugs.
 *   Splitting matches the framework's new contract:
 *     - render phase  → peekRevealedKey()      (read only)
 *     - server action → dismissRevealedKey()   (read + delete)
 *
 * The cookie's existing 120s `maxAge` is the safety belt: even if the
 * client-side dismiss never fires (JS disabled, network blip), the
 * cookie expires soon and won't leak into later page views.
 */
export async function peekRevealedKey(): Promise<string | null> {
  const store = await cookies();
  return store.get(REVEAL_COOKIE)?.value ?? null;
}

/**
 * Server action — actually deletes the reveal cookie. Called by the
 * `<RevealOnce>` client component's mount effect so the secret never
 * persists past one displayed-and-acknowledged view. Idempotent;
 * a second call is a harmless no-op.
 */
export async function dismissRevealedKey(): Promise<void> {
  const store = await cookies();
  if (store.get(REVEAL_COOKIE)?.value) {
    store.delete(REVEAL_COOKIE);
  }
}

// ===========================================================================
// Budgets — self-service CRUD
// ===========================================================================

/**
 * Resolve and ownership-check a project for the current session in one shot.
 * Throws via `redirect("/login")` when not authed, returns null when the
 * user doesn't own the named project (action becomes a silent no-op).
 */
async function requireOwnedProject(projectId: string) {
  const session = await requireSession();
  const project = await getProjectForUser(session.user.id, projectId);
  if (!project) return null;
  return { session, project };
}

function parseUsdAsMicroCents(raw: string): number | null {
  const n = Number(String(raw).trim().replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  // 1 USD = 100,000 micro_cents. Round to integer to match schema.
  return Math.round(n * 100_000);
}

export async function setBudgetAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;

  const period = String(formData.get("period") ?? "") as BudgetPeriod;
  if (period !== "daily" && period !== "monthly") return;

  const limitMicroCents = parseUsdAsMicroCents(
    String(formData.get("limit_usd") ?? "")
  );
  if (limitMicroCents == null) {
    redirect(`/projects/${projectId}?${toastQuery("budget-invalid")}#budgets`);
  }
  const enabled = formData.get("enabled") !== "off";

  const row = await upsertBudget(projectId, period, limitMicroCents, enabled);
  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "budget.set",
    targetType: "budget",
    targetId: row.id,
    metadata: { period, limit_micro_cents: limitMicroCents, enabled },
    ip,
    userAgent: ua,
  });
  // Same trade-off as setRoutingRuleAction below: revalidatePath instead
  // of redirect so the BudgetForm's React state survives a save.
  // Operators iterating over presets / sub-cent caps / monthly-vs-daily
  // were losing their input every time they clicked Save (the form
  // snapped back to defaults). Visual confirmation is the new row in
  // the budgets table; the form itself surfaces a "✓ Saved" pill.
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteBudgetAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const id = String(formData.get("id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;
  await deleteBudget(id, projectId);
  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "budget.deleted",
    targetType: "budget",
    targetId: id,
    ip,
    userAgent: ua,
  });
  redirect(`/projects/${projectId}?${toastQuery("budget-deleted")}#budgets`);
}

// ===========================================================================
// Routing rules — self-service CRUD
// ===========================================================================

export async function setRoutingRuleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;

  const fromPattern = String(formData.get("from_pattern") ?? "").trim();
  const toModel = String(formData.get("to_model") ?? "").trim();
  if (!fromPattern || !toModel) {
    redirect(`/projects/${projectId}?${toastQuery("routing-invalid")}#routing`);
  }
  // Validate regex up front so we don't write garbage that the gateway will
  // silently skip on every request.
  try {
    new RegExp(fromPattern);
  } catch {
    redirect(`/projects/${projectId}?${toastQuery("routing-bad-regex")}#routing`);
  }

  const thresholdRaw = Number(formData.get("threshold") ?? 0.3);
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.max(0, Math.min(1, thresholdRaw))
    : 0.3;
  const modeRaw = String(formData.get("mode") ?? "route") as RoutingMode;
  const mode: RoutingMode =
    modeRaw === "shadow" || modeRaw === "both" ? modeRaw : "route";
  const shadowRaw = String(formData.get("shadow_to_model") ?? "").trim();
  const shadowToModel =
    mode === "shadow" || mode === "both"
      ? shadowRaw || (mode === "both" ? fromPattern : null)
      : null;
  const enabled = formData.get("enabled") !== "off";

  // sample_rate (migration 020): probability the rule fires on a
  // qualifying request. Form sends an empty string when the user
  // picked "always fire" — we map that to NULL so the gateway's
  // legacy "fire on every match" code path stays untouched.
  // Anything else gets parsed + clamped to [0, 1].
  const sampleRateRaw = formData.get("sample_rate");
  let sampleRate: number | null = null;
  if (typeof sampleRateRaw === "string" && sampleRateRaw.trim() !== "") {
    const n = Number(sampleRateRaw);
    if (Number.isFinite(n)) {
      sampleRate = Math.max(0, Math.min(1, n));
    }
  }

  const row = await upsertRoutingRule(projectId, {
    fromPattern,
    toModel,
    threshold,
    mode,
    shadowToModel,
    enabled,
    sampleRate,
  });
  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "routing.set",
    targetType: "routing_rule",
    targetId: row.id,
    metadata: {
      from_pattern: fromPattern,
      to_model: toModel,
      threshold,
      mode,
      shadow_to_model: shadowToModel,
      enabled,
      sample_rate: sampleRate,
    },
    ip,
    userAgent: ua,
  });
  // Why revalidatePath instead of redirect — even though every other
  // action in this file redirects with a `?toast=` slug:
  //
  //   * The routing-rule form has 7 user-tweaked fields (from-pattern,
  //     to-model, threshold, mode, fire-on, shadow-target, enabled).
  //     Operators commonly add several similar rules in a row — same
  //     mode + threshold, different patterns. Resetting the form to
  //     defaults after every save (which is what redirect-driven
  //     navigation triggered, with React 19 + Next 15.0.7 not always
  //     preserving Client Component useState across same-route URL
  //     changes) destroyed that flow: pick "Route + Shadow", save,
  //     watch the highlight snap back to "Route", lose all form
  //     context.
  //   * `revalidatePath` refreshes the server-rendered tree (the
  //     newly-saved rule appears in the table below the form on the
  //     same render) but does NOT navigate. The Client Component
  //     RoutingRuleForm keeps its instance + useState, so mode /
  //     threshold / pattern stay exactly where the user left them.
  //   * The user's visual confirmation is the new row appearing in the
  //     table; the form additionally surfaces a transient "✓ Saved"
  //     pill (see RoutingRuleForm). Trade-off: no URL-driven toast,
  //     but the URL stays clean.
  //
  // Error redirects above (routing-invalid / routing-bad-regex) still
  // toast — error feedback can't be conveyed by "data appears in
  // table" the way success can.
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteRoutingRuleAction(
  formData: FormData
): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const id = String(formData.get("id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;
  await deleteRoutingRule(id, projectId);
  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "routing.deleted",
    targetType: "routing_rule",
    targetId: id,
    ip,
    userAgent: ua,
  });
  redirect(`/projects/${projectId}?${toastQuery("routing-deleted")}#routing`);
}

// ===========================================================================
// Alert rules — self-service CRUD
// ===========================================================================

export async function createAlertRuleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;

  const eventType = String(formData.get("event_type") ?? "") as AlertEventType;
  if (!ALERT_EVENT_TYPES.includes(eventType)) {
    redirect(`/projects/${projectId}?${toastQuery("alert-invalid")}#alerts`);
  }

  const webhookUrlRaw = String(formData.get("webhook_url") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  if (!webhookUrlRaw && !emailRaw) {
    redirect(`/projects/${projectId}?${toastQuery("alert-no-target")}#alerts`);
  }
  if (webhookUrlRaw) {
    try {
      new URL(webhookUrlRaw);
    } catch {
      redirect(`/projects/${projectId}?${toastQuery("alert-bad-url")}#alerts`);
    }
  }
  const enabled = formData.get("enabled") !== "off";

  const row = await createAlertRule(projectId, {
    eventType,
    webhookUrl: webhookUrlRaw || null,
    email: emailRaw || null,
    enabled,
  });
  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "alert.created",
    targetType: "alert_rule",
    targetId: row.id,
    metadata: {
      event_type: eventType,
      webhook_url: webhookUrlRaw || null,
      email: emailRaw || null,
      enabled,
    },
    ip,
    userAgent: ua,
  });
  // Same trade-off as setRoutingRuleAction / setBudgetAction: revalidate
  // the page rather than redirect so the AlertRuleForm's webhook URL +
  // event-type selection survive the save. The new row showing up
  // below the form (and the form's "✓ Saved" pill) is the success
  // signal in place of the URL-driven toast.
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteAlertRuleAction(
  formData: FormData
): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const id = String(formData.get("id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;
  await deleteAlertRule(id, projectId);
  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "alert.deleted",
    targetType: "alert_rule",
    targetId: id,
    ip,
    userAgent: ua,
  });
  redirect(`/projects/${projectId}?${toastQuery("alert-deleted")}#alerts`);
}

// ===========================================================================
// Routing rule "what would this match?" preview (server action, no mutation)
// ===========================================================================
//
// Called from the client RoutingRuleForm as the user types/picks a pattern.
// Returns "your new rule would have matched N requests in the last 7d on
// these models, totalling $X". Pure read; no audit log, no toast.

export async function previewRoutingRuleAction(input: {
  projectId: string;
  fromPattern: string;
}): Promise<RoutingMatchPreview | null> {
  const ctx = await requireOwnedProject(input.projectId);
  if (!ctx) return null;
  if (!input.fromPattern.trim()) return null;
  return previewRoutingMatch(input.projectId, input.fromPattern, 24 * 7);
}

// ===========================================================================
// Lock-an-auto-routing-decision-as-a-rule (A2)
// ===========================================================================
//
// Called from the request-detail page when a user wants to take what the
// baseline policy decided automatically and bake it into a project-level
// routing rule. The advantage: project rules run BEFORE the baseline
// policy, so the user gets deterministic, audit-able routing instead of
// "trust the policy."

export async function lockRoutingFromRequestAction(
  formData: FormData
): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;

  const fromModel = String(formData.get("from_model") ?? "").trim();
  const toModel = String(formData.get("to_model") ?? "").trim();
  if (!fromModel || !toModel) {
    redirect(`/projects/${projectId}?${toastQuery("routing-invalid")}#routing`);
  }

  // Anchor the from_model so it doesn't accidentally match a longer name
  // (e.g. "gpt-5" shouldn't catch "gpt-5.21-experimental").
  const escaped = fromModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fromPattern = `^${escaped}$`;

  // Threshold = 1.0 means "always fire" — the user just confirmed by
  // clicking that THIS specific routing decision was acceptable. We don't
  // try to second-guess with a complexity threshold; if they want to
  // narrow it later they can edit the rule.
  const row = await upsertRoutingRule(projectId, {
    fromPattern,
    toModel,
    threshold: 1.0,
    mode: "route",
    shadowToModel: null,
    enabled: true,
  });

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "routing.locked_from_request",
    targetType: "routing_rule",
    targetId: row.id,
    metadata: {
      from_model: fromModel,
      to_model: toModel,
      from_pattern: fromPattern,
      threshold: 1.0,
      mode: "route",
      source_request_id: String(formData.get("source_request_id") ?? ""),
    },
    ip,
    userAgent: ua,
  });
  redirect(`/projects/${projectId}?${toastQuery("routing-locked")}#routing`);
}

// ===========================================================================
// Test alert rule (webhook + email)
// ===========================================================================
//
// Routes through the gateway's `/internal/test-alert` endpoint instead of
// firing the webhook directly from the dashboard process. Two reasons:
//
//   1. Single source of truth for the alert envelope. The gateway's
//      `runAlertTest` reuses the same `deliverWebhook` / `deliverEmail`
//      helpers that real `dispatchAlert` calls go through, so what an
//      operator sees on Test is what they'll see in production —
//      identical headers (User-Agent, X-TokenSmart-Event), identical
//      JSON shape, identical Resend wiring.
//
//   2. Email actually works. RESEND_API_KEY is a gateway-side secret;
//      the dashboard process doesn't necessarily have it. Going through
//      the gateway lets the test panel exercise the real outbound path
//      and report per-channel status (webhook OK + email failed because
//      RESEND_API_KEY isn't set, etc.) — the previous webhook-only test
//      action couldn't tell the user anything about email.
//
// Audit log still records the attempt (not the response body — that may
// contain webhook signing data we shouldn't persist long-term).

const TEST_ALERT_TIMEOUT_MS = 12_000;

function gatewayUrl(): string {
  return (
    process.env.GATEWAY_URL?.replace(/\/$/, "") ?? "http://localhost:8787"
  );
}

type TestAlertResponse = {
  ok?: boolean;
  error?: string;
  webhook?:
    | { attempted: true; ok: true; status?: number }
    | {
        attempted: true;
        ok: false;
        status?: number;
        error: string;
      }
    | { attempted: false };
  email?:
    | { attempted: true; ok: true; status?: number }
    | {
        attempted: true;
        ok: false;
        status?: number;
        error: string;
        skipped?: boolean;
      }
    | { attempted: false };
};

export async function testAlertRuleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const ctx = await requireOwnedProject(projectId);
  if (!ctx) return;

  const id = String(formData.get("id") ?? "");
  if (!id) {
    redirect(`/projects/${projectId}?${toastQuery("alert-test-fail")}#alerts`);
  }

  const rule = await getAlertRuleById(id, projectId);
  if (!rule) {
    redirect(`/projects/${projectId}?${toastQuery("alert-test-fail")}#alerts`);
  }
  if (!rule!.webhook_url && !rule!.email) {
    redirect(
      `/projects/${projectId}?${toastQuery("alert-test-fail", { toast_arg: "no-target" })}#alerts`
    );
  }

  const internalToken = process.env.TOKENSMART_INTERNAL_TOKEN;
  if (!internalToken) {
    redirect(
      `/projects/${projectId}?${toastQuery("alert-test-fail", { toast_arg: "no-internal-token" })}#alerts`
    );
  }

  let payload: TestAlertResponse = {};
  let httpOk = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_ALERT_TIMEOUT_MS);
    try {
      const res = await fetch(`${gatewayUrl()}/internal/test-alert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tokensmart-internal-token": internalToken!,
        },
        body: JSON.stringify({ project_id: projectId, rule_id: id }),
        signal: controller.signal,
      });
      httpOk = res.ok;
      try {
        payload = (await res.json()) as TestAlertResponse;
      } catch {
        /* gateway returned non-JSON; payload stays {} */
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    payload = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const aggregateOk = httpOk && payload.ok === true;

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    projectId,
    event: "alert.tested",
    targetType: "alert_rule",
    targetId: id,
    metadata: {
      event_type: rule!.event_type,
      ok: aggregateOk,
      webhook_attempted: payload.webhook?.attempted ?? false,
      webhook_ok: payload.webhook?.attempted ? payload.webhook.ok : null,
      email_attempted: payload.email?.attempted ?? false,
      email_ok: payload.email?.attempted ? payload.email.ok : null,
    },
    ip,
    userAgent: ua,
  });

  // Build a short channel-summary string for the toast (e.g. "webhook
  // ok, email skipped (RESEND_API_KEY unset)") so the user gets actionable
  // feedback without clicking through to the audit log.
  const arg = summarizeTestResult(payload);

  redirect(
    `/projects/${projectId}?${toastQuery(
      aggregateOk ? "alert-test-ok" : "alert-test-fail",
      { toast_arg: arg }
    )}#alerts`
  );
}

/**
 * Compact channel summary suitable for a single-line toast. Keeps the
 * actionable bit (which channel, why) front-and-center; truncates so a
 * verbose Resend error doesn't blow up the URL length.
 */
function summarizeTestResult(payload: TestAlertResponse): string {
  const parts: string[] = [];
  const w = payload.webhook;
  if (w?.attempted) {
    if (w.ok) parts.push("webhook ok");
    else parts.push(`webhook fail (${(w.error ?? `HTTP ${w.status ?? "?"}`).slice(0, 60)})`);
  }
  const e = payload.email;
  if (e?.attempted) {
    if (e.ok) parts.push("email ok");
    else if (e.skipped)
      parts.push("email skipped (RESEND_API_KEY not set on gateway)");
    else parts.push(`email fail (${(e.error ?? `HTTP ${e.status ?? "?"}`).slice(0, 60)})`);
  }
  if (parts.length === 0) {
    return payload.error?.slice(0, 80) ?? "no channels attempted";
  }
  return parts.join(", ");
}

/** @deprecated kept as a thin wrapper for any straggling import that used
 *  the old name. New call sites should use `testAlertRuleAction`. */
export const testAlertWebhookAction = testAlertRuleAction;
