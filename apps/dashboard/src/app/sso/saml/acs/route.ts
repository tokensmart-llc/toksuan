import { NextResponse, type NextRequest } from "next/server";
import {
  getOrgSamlConfig,
  provisionSsoUser,
  recordConsumedAssertion,
} from "@/lib/db";
import { consumeSamlResponse, safeRelayPath } from "@/lib/saml";
import { createSession, setSessionCookie } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";

/**
 * Assertion Consumer Service (ACS).
 *
 * IdPs POST a urlencoded body with `SAMLResponse` (base64 XML) and an
 * optional `RelayState` (the absolute or relative URL we want the user
 * to land on post-login). We:
 *   1. Look up the org's IdP config.
 *   2. Hand the response to samlify for signature + audience + conditions
 *      verification.
 *   3. Replay-protect by inserting the assertion ID into
 *      `saml_consumed_assertions` (UNIQUE constraint stops dupes).
 *   4. JIT-provision (find-or-create) the user + add them to the org at
 *      the configured default role.
 *   5. Mint a TokSuan session cookie and 302 to RelayState (or `/`).
 *
 * Failure path renders a minimal HTML page with the error + remediation
 * — IdPs do not surface JSON cleanly to end users, and a redirect back
 * to /login would lose the diagnostic.
 */
export const dynamic = "force-dynamic";

async function readBody(req: NextRequest): Promise<{
  SAMLResponse: string;
  RelayState: string | null;
}> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return {
      SAMLResponse: params.get("SAMLResponse") ?? "",
      RelayState: params.get("RelayState"),
    };
  }
  // Some IdPs (rare) send multipart/form-data.
  if (ct.includes("multipart/form-data")) {
    const fd = await req.formData();
    return {
      SAMLResponse: String(fd.get("SAMLResponse") ?? ""),
      RelayState:
        typeof fd.get("RelayState") === "string"
          ? (fd.get("RelayState") as string)
          : null,
    };
  }
  // Fall back to URL-encoded read regardless.
  const text = await req.text();
  const params = new URLSearchParams(text);
  return {
    SAMLResponse: params.get("SAMLResponse") ?? "",
    RelayState: params.get("RelayState"),
  };
}

function clientIp(req: NextRequest): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

function errorPage(opts: {
  title: string;
  detail: string;
  remediation?: string | null;
  status: number;
}): Response {
  // Keep this self-contained — avoids dragging React server components
  // into the failure path and means the page works even if the styles
  // bundle isn't reachable yet.
  const safe = (s: string) =>
    s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8">
  <title>${safe(opts.title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
           max-width: 540px; margin: 80px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 18px; margin: 0 0 12px; }
    .det { background: #fff8f8; border: 1px solid #f3c5c5; padding: 12px;
           border-radius: 6px; color: #633; }
    .rem { background: #fafaf6; border: 1px solid #e8e0c5; padding: 12px;
           border-radius: 6px; color: #553; margin-top: 12px; }
    .ret { margin-top: 24px; }
    a { color: #1f6feb; }
  </style>
  <h1>${safe(opts.title)}</h1>
  <div class="det"><strong>Detail.</strong> ${safe(opts.detail)}</div>
  ${
    opts.remediation
      ? `<div class="rem"><strong>How to fix.</strong> ${safe(opts.remediation)}</div>`
      : ""
  }
  <div class="ret"><a href="/login">← Back to sign-in</a></div>`;
  return new Response(html, {
    status: opts.status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const orgId = req.nextUrl.searchParams.get("org");
  const ip = clientIp(req);
  if (!orgId) {
    return errorPage({
      title: "Missing organization id",
      detail:
        "The IdP must POST to /sso/saml/acs?org=<id>. Re-check the ACS URL configured in your IdP app.",
      status: 400,
    });
  }
  const cfg = await getOrgSamlConfig(orgId);
  if (!cfg || cfg.saml_enforcement_mode === "off") {
    return errorPage({
      title: "SSO not enabled",
      detail:
        "This organization does not have SAML enabled. Ask an org admin to configure it under Organization → SSO.",
      status: 404,
    });
  }
  const body = await readBody(req);
  if (!body.SAMLResponse) {
    return errorPage({
      title: "Missing SAMLResponse",
      detail:
        "The IdP POST did not include a SAMLResponse field. This is almost always a binding-mismatch on the IdP side.",
      remediation:
        "Configure the IdP application to use HTTP-POST for the SAML response (not HTTP-Redirect).",
      status: 400,
    });
  }

  const consumed = await consumeSamlResponse(cfg, body);
  if (!consumed.ok) {
    await logAuditEvent({
      userId: null,
      actorEmail: null,
      event: "auth.sso.failed",
      metadata: {
        org_id: orgId,
        reason: consumed.error,
      },
      ip,
    }).catch(() => {});
    return errorPage({
      title: "SSO assertion rejected",
      detail: consumed.error,
      remediation: consumed.remediation ?? null,
      status: 401,
    });
  }

  // Replay protection AFTER signature check passes — there's no point
  // recording an assertion ID we never trusted. Insert returns false on
  // duplicate (already consumed by an earlier request).
  const fresh = await recordConsumedAssertion(
    orgId,
    consumed.assertionId,
    consumed.notOnOrAfter
  );
  if (!fresh) {
    await logAuditEvent({
      userId: null,
      actorEmail: consumed.email,
      event: "auth.sso.failed",
      metadata: {
        org_id: orgId,
        reason: "assertion replay (already consumed)",
        assertion_id: consumed.assertionId,
      },
      ip,
    }).catch(() => {});
    return errorPage({
      title: "Assertion already used",
      detail:
        "This SAML assertion has been seen before. Replay attempts are blocked.",
      remediation:
        "Try signing in again — your IdP will mint a fresh assertion. If this keeps happening, your IdP may be POSTing the same response twice (clock skew or load-balancer retries).",
      status: 401,
    });
  }

  // JIT provision + session.
  const provisioned = await provisionSsoUser({
    email: consumed.email,
    ssoSubject: consumed.nameId,
    organizationId: orgId,
    defaultRole: cfg.saml_default_role,
  });

  const sessionToken = await createSession(provisioned.id);
  await setSessionCookie(sessionToken);

  await logAuditEvent({
    userId: provisioned.id,
    actorEmail: consumed.email,
    event: "auth.sso.login",
    metadata: {
      org_id: orgId,
      assertion_id: consumed.assertionId,
      jit_user_created: provisioned.created,
      jit_member_created: provisioned.promotedToMember,
    },
    ip,
    userAgent: req.headers.get("user-agent"),
  }).catch(() => {});

  const target = safeRelayPath(consumed.relayState);
  return NextResponse.redirect(new URL(target, req.url), 302);
}
