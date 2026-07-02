import { NextResponse, type NextRequest } from "next/server";

/**
 * Lightweight auth gate. Runs on every page navigation but does NOT talk to
 * the database — it only inspects cookie presence. Actual session validation
 * happens in the server component via `getSession()`, which will redirect
 * again if the cookie turns out to be stale.
 *
 * When `TOKENSMART_AUTH_ENABLED` is unset or `0`, this is a no-op. That's
 * the self-hosted single-tenant mode.
 */
const SESSION_COOKIE = "tokensmart_session";
const REFERRAL_COOKIE = "ts_ref";
const REFERRAL_TTL_DAYS = 30;
/** Must match `SESSION_DAYS` in lib/auth.ts — middleware re-stamps the
 *  cookie's Max-Age on every authed request so an active user gets a
 *  sliding window. We can't import the constant directly: middleware
 *  runs on the edge runtime and lib/auth.ts pulls in `postgres`. */
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
// Public because webhooks / OAuth-style callbacks never carry our cookie, and
// marketing/proof surfaces (`/estimate`, `/trust`, `/state-of-agent-spend`,
// `/routing-quality`) need to be reachable before signup.
const PUBLIC_PREFIXES = [
  "/health",
  "/login",
  "/logout",
  "/api/stripe/webhook",
  "/estimate",
  // Public proof / procurement surfaces linked from the marketing landing.
  // These must remain readable without a session; their pages conditionally
  // hide app-only chrome when the user is anonymous.
  "/trust",
  "/state-of-agent-spend",
  "/routing-quality",
  "/api/telemetry",
  // Unsubscribe flow. Users click the link in a marketing/digest email
  // months after their session expired; the per-user `unsubscribe_token`
  // IS the credential, validated against `users.unsubscribe_token` by
  // the handler. Both the HTML confirmation page (/unsubscribe) and the
  // RFC-8058 one-click POST endpoint (/api/unsubscribe) are public.
  "/unsubscribe",
  "/api/unsubscribe",
  // SAML SSO endpoints — IdPs POST AuthnResponses without our session
  // cookie, the metadata XML is fetched by IdP admins anonymously, and
  // the redirect-to-IdP is the entry point for users WITHOUT a session
  // (the whole point). Same gate applies as /login.
  "/sso/saml",
];

/**
 * Capture `?ref=<code>` into a 30-day HTTP-only cookie so the eventual
 * signup attribution doesn't depend on the user not navigating before
 * they hit "sign up". Only sets when the cookie isn't already present —
 * once a referral is sticky, we don't let a later `?ref=other` overwrite
 * it (last-touch attribution would be gameable; first-touch matches how
 * Stripe Promotion Codes attribute too).
 */
function maybeStoreReferralCookie(
  req: NextRequest,
  res: NextResponse
): NextResponse {
  const ref = req.nextUrl.searchParams.get("ref");
  if (!ref) return res;
  const sanitized = ref.trim().toLowerCase();
  if (!/^[a-z0-9]{4,32}$/.test(sanitized)) return res;
  if (req.cookies.get(REFERRAL_COOKIE)) return res;
  res.cookies.set(REFERRAL_COOKIE, sanitized, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: REFERRAL_TTL_DAYS * 24 * 60 * 60,
  });
  return res;
}

/**
 * Re-stamp the session cookie's Max-Age on every authed request so
 * active users get a sliding window. The DB side of the slide happens
 * in `getSession()`; this is the browser-side half.
 *
 * Cheap — single Set-Cookie header per request. Skipped when the
 * cookie is absent (the middleware is about to redirect to /login
 * anyway) or when we're in single-tenant mode.
 */
function refreshSessionCookie(
  req: NextRequest,
  res: NextResponse
): NextResponse {
  const existing = req.cookies.get(SESSION_COOKIE)?.value;
  if (!existing) return res;
  res.cookies.set(SESSION_COOKIE, existing, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

export function middleware(req: NextRequest): NextResponse {
  if (process.env.TOKENSMART_AUTH_ENABLED !== "1") {
    return maybeStoreReferralCookie(req, NextResponse.next());
  }

  const { pathname } = req.nextUrl;

  // Public landing page. Authenticated users still see the dashboard because
  // app/page.tsx checks the session and renders the authed surface.
  if (pathname === "/") {
    return maybeStoreReferralCookie(req, NextResponse.next());
  }

  // Public routes (login flow + logout) are always reachable.
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return maybeStoreReferralCookie(req, NextResponse.next());
  }

  // Must have a session cookie. Don't validate it here — that would require
  // hitting Postgres from the edge. Pages revalidate via getSession() and
  // redirect if the cookie is stale.
  if (!req.cookies.get(SESSION_COOKIE)) {
    // Preserve the requested path so /login can bounce the user back
    // after sign-in. Critical for invitation-accept flows, deep links
    // shared between coworkers, and any bookmark saved before auth
    // was enabled. Only passes the pathname+search (never the origin)
    // so an attacker can't craft `?next=https://evil.example.com` —
    // open-redirect protection lives in `safeRelayPath()`.
    const originalPath = pathname + req.nextUrl.search;
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (originalPath && originalPath !== "/") {
      url.searchParams.set("next", originalPath);
    }
    return maybeStoreReferralCookie(req, NextResponse.redirect(url));
  }

  return refreshSessionCookie(
    req,
    maybeStoreReferralCookie(req, NextResponse.next())
  );
}

export const config = {
  matcher: [
    // Gate everything except Next internals, static assets, and SEO
    // metadata routes. Each negated prefix is anchored with `(?=$|\?|\.)`
    // so we only match THOSE exact routes — otherwise `icon` in the
    // list would also skip auth on a hypothetical `/iconic-page`.
    //
    // Anonymous surfaces (must bypass auth when TOKENSMART_AUTH_ENABLED=1):
    //   /_next/*         — Next.js internal assets + RSC payloads
    //   /favicon.ico     — legacy browser probe
    //   /icon            — dynamic favicon (app/icon.tsx)
    //   /apple-icon      — dynamic apple touch icon (if we add one)
    //   /opengraph-image — dynamic OG image (app/opengraph-image.tsx)
    //   /twitter-image   — dynamic Twitter card (if we add one)
    //   /robots.txt      — Googlebot + crawler directives
    //   /sitemap.xml     — structured URL index for search engines
    "/((?!_next/|favicon\\.ico(?:$|\\?)|icon(?:$|\\?|\\.)|apple-icon(?:$|\\?|\\.)|opengraph-image(?:$|\\?|\\.)|twitter-image(?:$|\\?|\\.)|robots\\.txt(?:$|\\?)|sitemap\\.xml(?:$|\\?)).*)",
  ],
};
