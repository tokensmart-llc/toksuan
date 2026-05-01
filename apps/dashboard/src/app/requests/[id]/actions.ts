"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getScope, getSession, userOwnsProject } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import { getRequestById } from "@/lib/db";

async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

async function actorIp(): Promise<string | null> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}

function gatewayUrl(): string {
  return (
    process.env.GATEWAY_URL?.replace(/\/$/, "") ?? "http://localhost:8787"
  );
}

/**
 * Re-issue an existing request against the chosen model via the gateway's
 * internal `/internal/replay` endpoint.
 *
 * Authorization model:
 *   - Caller must be authenticated (server action) AND own the project the
 *     original request lives in (we re-fetch via getRequestById with the
 *     user's scope; null = not owned).
 *   - Gateway endpoint requires TOKENSMART_INTERNAL_REPLAY_ENABLED=1 and
 *     authenticates via TOKENSMART_INTERNAL_TOKEN, a shared secret deployed
 *     on both processes. Set on the dashboard's env (server-only) — NEVER
 *     NEXT_PUBLIC_*.
 *
 * On success: redirect to the NEW request's detail page with a toast.
 * On failure: redirect back to the source page with an error toast.
 */
export async function replayRequestAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const sourceId = String(formData.get("request_id") ?? "");
  const targetModel = String(formData.get("target_model") ?? "").trim();
  if (!sourceId || !targetModel) {
    redirect(`/requests/${sourceId}?toast=request-replay-failed&toast_arg=missing-fields`);
  }

  // Look the request up through the same scope helper the read pages use
  // (`getScope()` includes both personally owned projects and org-shared
  // projects the caller can see). Then enforce a stricter mutate check so
  // org viewers can read the request but cannot fire a replay.
  const scope = await getScope();
  const detail = await getRequestById(sourceId, scope);
  if (!detail) {
    redirect(`/requests/${sourceId}?toast=request-replay-failed&toast_arg=not-found`);
  }
  if (!detail.project_id) {
    redirect(`/requests/${sourceId}?toast=request-replay-failed&toast_arg=no-project`);
  }
  if (!(await userOwnsProject(session.user.id, detail.project_id))) {
    redirect(
      `/requests/${sourceId}?toast=request-replay-failed&toast_arg=not-found`
    );
  }

  const internalToken = process.env.TOKENSMART_INTERNAL_TOKEN;
  if (process.env.TOKENSMART_INTERNAL_REPLAY_ENABLED !== "1" || !internalToken) {
    redirect(
      `/requests/${sourceId}?toast=request-replay-failed&toast_arg=set-internal-replay-env`
    );
  }

  // The body sent to the gateway is the ORIGINAL request body, with the
  // model swapped to the user's chosen target. The gateway's replay
  // endpoint also overrides body.model so this is belt-and-braces.
  const replayBody =
    detail.request_body && typeof detail.request_body === "object"
      ? { ...(detail.request_body as Record<string, unknown>), model: targetModel }
      : { model: targetModel, messages: [] };

  let res: Response;
  try {
    res = await fetch(`${gatewayUrl()}/internal/replay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tokensmart-internal-token": internalToken,
      },
      body: JSON.stringify({
        project_id: detail.project_id,
        model: targetModel,
        body: replayBody,
        replay_of_request_id: sourceId,
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    redirect(
      `/requests/${sourceId}?toast=request-replay-failed&toast_arg=${encodeURIComponent(
        detail.slice(0, 80)
      )}`
    );
  }

  let payload: { ok?: boolean; request_id?: string; error?: string } = {};
  try {
    payload = await res.json();
  } catch {
    /* ignore */
  }

  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "request.replayed",
    targetType: "request",
    targetId: sourceId,
    metadata: {
      target_model: targetModel,
      new_request_id: payload.request_id ?? null,
      ok: !!payload.ok,
      error: payload.error ?? null,
    },
    ip: await actorIp(),
  });

  if (!payload.ok || !payload.request_id) {
    redirect(
      `/requests/${sourceId}?toast=request-replay-failed&toast_arg=${encodeURIComponent(
        (payload.error ?? "unknown").slice(0, 80)
      )}`
    );
  }

  redirect(
    `/requests/${payload.request_id}?toast=request-replay-queued&toast_arg=${encodeURIComponent(
      targetModel
    )}`
  );
}
