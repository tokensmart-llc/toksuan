import { NextResponse, type NextRequest } from "next/server";
import { getOrgSamlConfig } from "@/lib/db";
import { buildLoginRedirect, safeRelayPath } from "@/lib/saml";
import { logAuditEvent } from "@/lib/audit";

/**
 * SP-initiated SSO entry point. The /login page redirects here after
 * detecting the user typed an email whose domain matches an org's
 * `saml_email_domain` (with enforcement >= 'optional'). We construct
 * the SAML AuthnRequest, embed it in the IdP's SSO URL via the
 * HTTP-Redirect binding, and 302 the browser there.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const orgId = req.nextUrl.searchParams.get("org");
  if (!orgId) {
    return NextResponse.json(
      { error: "Missing ?org=<organization_id>." },
      { status: 400 }
    );
  }
  const cfg = await getOrgSamlConfig(orgId);
  if (!cfg || cfg.saml_enforcement_mode === "off") {
    return NextResponse.json(
      { error: "SAML is not enabled for this organization." },
      { status: 404 }
    );
  }
  // RelayState is a SAML-spec opaque blob; we use it to remember the
  // pre-login URL and bounce the user there after ACS finishes.
  const relayState = safeRelayPath(req.nextUrl.searchParams.get("next"));

  let url: string;
  try {
    url = buildLoginRedirect(cfg, relayState);
  } catch (err) {
    await logAuditEvent({
      userId: null,
      actorEmail: null,
      event: "auth.sso.failed",
      metadata: {
        org_id: orgId,
        stage: "build_login_redirect",
        error: err instanceof Error ? err.message : String(err),
      },
      ip: null,
    }).catch(() => {});
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to build SAML AuthnRequest.",
        remediation:
          "Check the org's IdP metadata XML / entity ID / SSO URL / cert in the dashboard.",
      },
      { status: 500 }
    );
  }
  return NextResponse.redirect(url, 302);
}
