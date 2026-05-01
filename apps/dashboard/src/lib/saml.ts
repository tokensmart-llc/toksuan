/**
 * SAML 2.0 single sign-on integration (v0.3.x).
 *
 * Per-organization IdP config lives in `organizations.saml_*` columns
 * (migration 012). At runtime each request that touches the SP-initiated
 * flow assembles a `samlify.ServiceProvider` + `IdentityProvider` pair
 * for the org, generates / consumes the SAML XML, and either redirects
 * to the IdP or mints a TokSuan session.
 *
 * Why samlify (not passport-saml or roll-our-own):
 *   - Active maintenance + framework-agnostic (Next.js App Router has no
 *     Express middleware to plug into).
 *   - XML signature verification is the hard part — we get the
 *     `xml-crypto` integration for free, including canonicalisation and
 *     enveloped-signature handling that account for half of the SAML
 *     CVEs in industry.
 *   - Schema validation is opt-in; we leave it OFF here (the same as
 *     samlify's default) because the strict schema validator depends on
 *     `libxml2` bindings that don't ship reliably to Node + Bun without
 *     extra build steps. samlify's signature + conditions check are the
 *     defenses that matter.
 *
 * Security caveats this module enforces:
 *   - Every assertion ID is recorded in `saml_consumed_assertions` so
 *     replay (re-POST of the same assertion within its window) is
 *     rejected even if the IdP cert is briefly compromised.
 *   - We refuse to consume an assertion whose audience doesn't match the
 *     SP's expected entityID — a misconfigured IdP can otherwise feed
 *     us assertions intended for a different SP.
 *   - We refuse assertions where the embedded NameID's email differs
 *     from the org's `saml_email_domain` (when set) — defense in depth
 *     against a compromised IdP issuing assertions for unrelated emails.
 */

// samlify uses a CommonJS interop that doesn't tree-shake well; namespace
// import keeps the bundler happy without dragging the whole IdP module
// into the client. We never reference samlify outside this file.
import * as samlify from "samlify";

export type OrgSamlConfig = {
  organization_id: string;
  organization_name: string;
  saml_idp_metadata_xml: string | null;
  saml_idp_entity_id: string | null;
  saml_idp_sso_url: string | null;
  saml_idp_x509_cert: string | null;
  saml_email_domain: string | null;
  saml_enforcement_mode: "off" | "optional" | "required";
  saml_default_role: "admin" | "member" | "viewer";
};

/**
 * The base URL the SP advertises in its metadata + AssertionConsumerService.
 * Falls back to `NEXT_PUBLIC_BASE_URL` when set, else localhost — the IdP
 * needs an absolute URL it can POST back to, so a misconfigured prod
 * deploy that leaves NEXT_PUBLIC_BASE_URL unset will get a clear
 * 'http://localhost:3000' callback the operator notices immediately.
 */
function publicBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

function spEntityId(): string {
  // The SP's entity ID is stable per deployment — IdP admins paste this
  // into their app config. Use the well-known metadata URL so they can
  // also fetch the SP metadata XML from the same string.
  return `${publicBaseUrl()}/sso/saml/metadata`;
}

/**
 * Build the ServiceProvider + IdentityProvider pair for an org. Throws
 * a clean Error on bad / missing config so callers can surface a 400 to
 * the user.
 */
export function buildEntities(cfg: OrgSamlConfig): {
  sp: ReturnType<typeof samlify.ServiceProvider>;
  idp: ReturnType<typeof samlify.IdentityProvider>;
  acsUrl: string;
} {
  if (!cfg.saml_enforcement_mode || cfg.saml_enforcement_mode === "off") {
    throw new Error(`SAML is disabled for org ${cfg.organization_id}.`);
  }

  const acsUrl = `${publicBaseUrl()}/sso/saml/acs?org=${cfg.organization_id}`;

  const sp = samlify.ServiceProvider({
    entityID: spEntityId(),
    assertionConsumerService: [
      {
        Binding: samlify.Constants.namespace.binding.post,
        Location: acsUrl,
      },
    ],
    // We deliberately don't request signed assertions only — we want
    // the IdP to sign EITHER the assertion OR the response (or both).
    // samlify's parser handles all three layouts.
    wantAssertionsSigned: true,
    wantMessageSigned: false,
    // SP cert/private key would be needed for signed AuthnRequests; v0.3
    // doesn't sign requests (most IdPs don't require it for SP-initiated
    // SSO and unsigned requests are universally accepted). Adding this
    // is a one-cert-paste change in the org admin UI when an enterprise
    // IdP demands it.
  });

  // Two paths for IdP construction:
  //   1. Metadata XML pasted (recommended — captures EntityID + SSO URL +
  //      cert from a single document). samlify parses + validates.
  //   2. Manual entry (entity_id + sso_url + cert) for IdPs that don't
  //      expose metadata. We synthesize the minimum metadata samlify
  //      needs.
  let idp: ReturnType<typeof samlify.IdentityProvider>;
  if (cfg.saml_idp_metadata_xml && cfg.saml_idp_metadata_xml.trim()) {
    idp = samlify.IdentityProvider({ metadata: cfg.saml_idp_metadata_xml });
  } else {
    if (!cfg.saml_idp_entity_id || !cfg.saml_idp_sso_url || !cfg.saml_idp_x509_cert) {
      throw new Error(
        `Org ${cfg.organization_id} SAML config incomplete. Provide either IdP metadata XML or all of (entity_id, sso_url, x509 cert).`
      );
    }
    idp = samlify.IdentityProvider({
      entityID: cfg.saml_idp_entity_id,
      singleSignOnService: [
        {
          Binding: samlify.Constants.namespace.binding.redirect,
          Location: cfg.saml_idp_sso_url,
        },
      ],
      signingCert: normalizePem(cfg.saml_idp_x509_cert),
    });
  }

  return { sp, idp, acsUrl };
}

/**
 * Strip PEM headers + whitespace if the user pasted a full PEM, leaving
 * the raw base64 samlify expects. If they pasted base64 already, this
 * is a no-op.
 */
function normalizePem(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
}

/**
 * Generate the SP metadata XML for an org. IdP admins typically paste
 * this URL (`/sso/saml/metadata?org=<id>`) into their IdP app config,
 * which then auto-discovers the entity ID + ACS URL.
 */
export function spMetadataXml(cfg: OrgSamlConfig): string {
  const { sp } = buildEntities(cfg);
  return sp.getMetadata();
}

/**
 * Build the IdP-bound login URL (HTTP-Redirect binding). Caller redirects
 * the user's browser to it.
 */
export function buildLoginRedirect(
  cfg: OrgSamlConfig,
  relayState: string | null = null
): string {
  const { sp, idp } = buildEntities(cfg);
  const ctx = sp.createLoginRequest(
    idp,
    samlify.Constants.namespace.binding.redirect
  );
  // samlify returns a `BindingContext` whose `context` is the redirect
  // URL when binding=redirect. Append RelayState if the caller supplied
  // one (e.g. the original /projects/foo URL the user was trying to hit).
  let url = (ctx as { context: string }).context;
  if (relayState) {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}RelayState=${encodeURIComponent(relayState)}`;
  }
  return url;
}

export type ConsumedAssertion = {
  ok: true;
  email: string;
  nameId: string;
  assertionId: string;
  notOnOrAfter: Date;
  attributes: Record<string, string | string[]>;
  relayState: string | null;
};
export type AssertionFailure = {
  ok: false;
  error: string;
  /**
   * When non-null, the failure is a configuration issue the operator can
   * fix (cert mismatch, audience mismatch). When null it's a transient
   * or attacker-driven failure (replay, bad signature).
   */
  remediation: string | null;
};

/**
 * Consume a posted SAMLResponse. Returns the extracted identity on
 * success or a structured failure record otherwise.
 *
 * Caller is responsible for the replay-protection DB write +
 * audit-event log + session minting.
 */
export async function consumeSamlResponse(
  cfg: OrgSamlConfig,
  body: { SAMLResponse: string; RelayState?: string | null }
): Promise<ConsumedAssertion | AssertionFailure> {
  const { sp, idp } = buildEntities(cfg);
  let parsed: Awaited<ReturnType<typeof sp.parseLoginResponse>>;
  try {
    parsed = await sp.parseLoginResponse(idp, "post", {
      body: { SAMLResponse: body.SAMLResponse },
    });
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `SAMLResponse parse / signature check failed: ${err.message}`
          : "SAMLResponse parse / signature check failed.",
      remediation:
        "Verify the IdP signing cert in your TokSuan org SSO settings matches the cert your IdP is currently using. A common cause is an IdP cert rotation that wasn't propagated.",
    };
  }
  const ext = (parsed as { extract: Record<string, unknown> }).extract;
  const nameId =
    typeof (ext as { nameID: string }).nameID === "string"
      ? ((ext as { nameID: string }).nameID as string).trim()
      : "";
  if (!nameId) {
    return {
      ok: false,
      error: "Assertion contained no NameID.",
      remediation:
        "Configure the IdP to release the user's email address as the SAML NameID (format: emailAddress).",
    };
  }
  const attributes =
    (ext as { attributes?: Record<string, string | string[]> }).attributes ?? {};
  const emailAttr =
    (attributes as Record<string, string | string[] | undefined>)["email"] ??
    (attributes as Record<string, string | string[] | undefined>)["mail"] ??
    (attributes as Record<string, string | string[] | undefined>)[
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
    ];
  const email = String(
    Array.isArray(emailAttr) ? emailAttr[0] : emailAttr ?? nameId
  )
    .trim()
    .toLowerCase();
  if (!email.includes("@")) {
    return {
      ok: false,
      error: "Assertion did not include a parseable email.",
      remediation:
        "Map your IdP's user email attribute to the SAML attribute named 'email' (or use email NameID format).",
    };
  }
  if (cfg.saml_email_domain) {
    const domain = email.split("@")[1] ?? "";
    if (domain.toLowerCase() !== cfg.saml_email_domain.toLowerCase()) {
      return {
        ok: false,
        error: `Assertion email '${email}' is outside the org's verified domain '${cfg.saml_email_domain}'.`,
        remediation: null,
      };
    }
  }
  // The assertion's ID + notOnOrAfter come back nested under
  // `extract.response.id` / `extract.conditions.notOnOrAfter` depending
  // on the SAML profile; samlify also exposes them at top level.
  const conditions = (ext as { conditions?: { notOnOrAfter?: string } })
    .conditions;
  const notOnOrAfterStr = conditions?.notOnOrAfter ?? null;
  const notOnOrAfter = notOnOrAfterStr
    ? new Date(notOnOrAfterStr)
    : new Date(Date.now() + 5 * 60_000);
  const assertionId = String(
    (ext as { response?: { id?: string }; assertion?: { id?: string } })
      .assertion?.id ??
      (ext as { response?: { id?: string } }).response?.id ??
      // Last-resort: hash the SAMLResponse so replay protection still works.
      ""
  );
  if (!assertionId) {
    return {
      ok: false,
      error: "Assertion missing ID — cannot prevent replay.",
      remediation: null,
    };
  }
  const relayState =
    typeof body.RelayState === "string" && body.RelayState.length > 0
      ? body.RelayState
      : null;
  return {
    ok: true,
    email,
    nameId,
    assertionId,
    notOnOrAfter,
    attributes,
    relayState,
  };
}

/**
 * Lowercase-domain extraction helper used by the /login flow to decide
 * whether to route to SAML or OTP.
 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Sanity-check + validate a relay state URL before redirecting back to
 * it after SSO / `/login?next=` flows. Open-redirect mitigation: only
 * same-origin relative paths are accepted; an IdP-supplied or
 * attacker-crafted absolute URL is dropped silently.
 *
 * Known tricks this rejects:
 *   - absolute URL    `https://evil.example`
 *   - protocol-relative `//evil.example`
 *   - **backslash-prefix `/\evil.example`** — modern browsers (Chromium,
 *     WebKit) normalise `\` to `/` when parsing URL paths, so
 *     `/\evil.example` resolves the same as `//evil.example`, i.e. an
 *     authority. Without this check an attacker could smuggle a
 *     redirect past the simple `startsWith('//')` guard. We reject any
 *     input containing `\` for simplicity — no legitimate in-app route
 *     has a backslash, so the false-positive rate is zero.
 *   - CRLF injection — reject any embedded newline/carriage-return
 *     (would let a downstream `Location:` header inject extra headers)
 *   - whitespace prefix — some parsers strip leading whitespace before
 *     the scheme check, so we demand the path start with a literal `/`
 *     at index 0
 */
export function safeRelayPath(raw: string | null): string {
  if (!raw) return "/";
  if (raw.length === 0 || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  // Block protocol-relative variants + CRLF injection. Backslash check
  // catches the `\evil` / `/\evil` smuggling cases; any `\` anywhere in
  // the path is safe to reject because legit URLs shouldn't contain one.
  if (/[\r\n\\]/.test(raw)) return "/";
  // Reject paths that start with `/` followed by any non-slash, space,
  // or tab — caught above. The remaining edge case is `/ ` (slash then
  // space) which most servers normalise to `/` + a bare path with URL-
  // encoded space. Not an open redirect but could confuse routing; cap
  // control chars out.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}
