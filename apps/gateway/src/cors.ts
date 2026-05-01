import type { MiddlewareHandler } from "hono";

/**
 * Minimal, zero-dep CORS middleware for Hono.
 *
 * Why hand-rolled instead of Hono's `cors()` helper: we want:
 *  - exact-match allowlist driven by a single env var
 *  - `*` pass-through WITHOUT credentials (the safe default)
 *  - visibility into why a request was rejected (log the rejected
 *    origin once per boot so operators can debug)
 *  - no extra dep
 *
 * The gateway authenticates via `Authorization: Bearer <ts_key>`,
 * NOT cookies — so we intentionally never send
 * `Access-Control-Allow-Credentials: true`. Browsers that add
 * `credentials: "include"` to their fetch will simply not receive
 * the allow-credentials header and the request won't be credentialed,
 * which is correct: the Authorization header is explicitly set by
 * the integrating SDK, not automatically attached by the browser.
 *
 * Allowed method set mirrors the OpenAI-compat chat endpoint's
 * actual surface — GET for /health, POST for /v1/chat/completions,
 * OPTIONS for preflight.
 */

const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "x-ts-tag",
  "x-ts-template",
  "x-ts-template-vars",
  // Well-known OpenClaw / agent attribution headers — promoted to first-
  // class because every long-running agent ends up wanting them.
  "x-ts-agent",
  "x-ts-session",
  "x-ts-turn",
  "x-ts-channel",
].join(", ");

// Headers the gateway ALWAYS surfaces on its responses that browser
// JS would otherwise be unable to read off `fetch()` (browsers hide
// every non-CORS-safe header by default). Listing them in
// Access-Control-Expose-Headers makes the request id visible to a
// dashboard SPA / agent inspector running in a browser tab.
const EXPOSED_HEADERS = ["x-request-id", "x-tokensmart-request-id"].join(", ");

const ALLOWED_METHODS = "GET, POST, OPTIONS";

// Max-Age caps preflight caching at 24h. Longer would be nicer for
// reducing preflight volume, but some browsers silently truncate
// long values and we don't want policy changes stuck in a CDN
// cache for a week.
const MAX_AGE_SECONDS = 86_400;

function parseOrigins(raw: string | undefined): {
  mode: "off" | "wildcard" | "allowlist";
  allowlist: Set<string>;
} {
  if (!raw || raw.trim() === "") return { mode: "off", allowlist: new Set() };
  const trimmed = raw.trim();
  if (trimmed === "*") return { mode: "wildcard", allowlist: new Set() };
  const allowlist = new Set(
    trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  if (allowlist.size === 0) return { mode: "off", allowlist: new Set() };
  return { mode: "allowlist", allowlist };
}

export function createCorsMiddleware(): MiddlewareHandler {
  const { mode, allowlist } = parseOrigins(
    process.env.TOKENSMART_CORS_ALLOW_ORIGINS
  );

  if (mode !== "off") {
    console.log(
      `[tokensmart] CORS enabled (${mode}${
        mode === "allowlist" ? `: ${[...allowlist].join(", ")}` : ""
      })`
    );
  }

  // Log-once bookkeeping for rejected origins — we don't want to flood
  // stdout with the same rejection every request, but a first-time
  // rejection is genuinely useful debugging signal.
  const warnedOrigins = new Set<string>();

  return async (c, next) => {
    if (mode === "off") {
      // Even with CORS "off" we must answer preflight politely or the
      // browser turns it into a hard error visible to the user. 204 +
      // no allow-* headers is the correct "we don't do CORS" response
      // — same as hitting a plain non-CORS endpoint.
      if (c.req.method === "OPTIONS") {
        return c.body(null, 204);
      }
      return next();
    }

    const origin = c.req.header("origin");
    let allowedOrigin: string | null = null;

    if (mode === "wildcard") {
      allowedOrigin = "*";
    } else if (origin && allowlist.has(origin)) {
      allowedOrigin = origin;
    } else if (origin && !warnedOrigins.has(origin)) {
      warnedOrigins.add(origin);
      console.warn(
        `[cors] rejected origin '${origin}' — not in TOKENSMART_CORS_ALLOW_ORIGINS`
      );
    }

    // Preflight. Answer with 204 + allow-* headers (only if the origin
    // passed the check; otherwise the browser will surface a CORS error
    // to the caller and the actual request will never be sent).
    if (c.req.method === "OPTIONS") {
      if (allowedOrigin) {
        c.header("Access-Control-Allow-Origin", allowedOrigin);
        c.header("Vary", "Origin");
        c.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
        c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        c.header("Access-Control-Max-Age", String(MAX_AGE_SECONDS));
      }
      return c.body(null, 204);
    }

    // Actual request. If the origin was accepted, stamp the allow
    // header on the outgoing response so the browser releases the
    // bytes to the caller.
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Vary", "Origin");
      // Without Expose-Headers a browser can read response headers
      // only from the CORS-safelisted set; the request id would be
      // silently invisible to JS even though we send it.
      c.header("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    }

    return next();
  };
}
