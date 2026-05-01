/**
 * Cross-provider failover + automatic retry on transient upstream errors.
 *
 * Two layers:
 *
 *   1. Automatic retry — when an upstream returns a transient error (5xx / 408
 *      / 429-from-upstream / network exception), retry up to N times with
 *      exponential backoff + jitter. Always against the SAME provider/model
 *      first — most rate-limits and 5xxs clear within hundreds of ms.
 *
 *   2. Cross-provider failover — if the user has set TOKENSMART_FAILOVER_MAP
 *      and retries still fail, swap the model to the configured failover and
 *      try ONCE more (which itself may retry per layer 1, against the new
 *      provider). This is what saves the request when OpenAI is degraded
 *      and you need Anthropic to step in transparently.
 *
 * Environment:
 *   TOKENSMART_FAILOVER_MAP="gpt-4o=>claude-3-5-sonnet-latest,gpt-5.2=>claude-3-7-sonnet-latest"
 *   TOKENSMART_RETRY_MAX_ATTEMPTS=2     # default; total attempts = 1 + this
 *   TOKENSMART_RETRY_BASE_DELAY_MS=200  # backoff base; full jitter applied
 *
 * Why this exists: production agents on OpenAI hit ~99.5% reliability over a
 * day. The 0.5% is concentrated in 30-second incidents that, without retry,
 * surface to end users as failed agent runs. Failover turns provider outages
 * into a degraded-but-working state, not a customer-facing failure.
 */

const RETRY_MAX_ATTEMPTS_DEFAULT = 2;
const RETRY_BASE_DELAY_MS_DEFAULT = 200;

let _failoverMap: Map<string, string> | null = null;

/**
 * Parse `TOKENSMART_FAILOVER_MAP` once and cache. Format:
 *   "from1=>to1,from2=>to2"
 * Whitespace around `=>` and `,` is tolerated. Empty / missing → empty map.
 */
export function getFailoverMap(): Map<string, string> {
  if (_failoverMap) return _failoverMap;
  const raw = process.env.TOKENSMART_FAILOVER_MAP ?? "";
  const m = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [from, to] = trimmed.split("=>").map((s) => s.trim());
    if (from && to) m.set(from, to);
  }
  _failoverMap = m;
  if (m.size > 0) {
    const desc = [...m.entries()].map(([f, t]) => `${f}→${t}`).join(", ");
    console.log(`[tokensmart] cross-provider failover ENABLED: ${desc}`);
  }
  return m;
}

export function getRetryMaxAttempts(): number {
  const raw = process.env.TOKENSMART_RETRY_MAX_ATTEMPTS;
  const n = raw ? Number(raw) : RETRY_MAX_ATTEMPTS_DEFAULT;
  return Number.isFinite(n) && n >= 0 ? n : RETRY_MAX_ATTEMPTS_DEFAULT;
}

export function getRetryBaseDelayMs(): number {
  const raw = process.env.TOKENSMART_RETRY_BASE_DELAY_MS;
  const n = raw ? Number(raw) : RETRY_BASE_DELAY_MS_DEFAULT;
  return Number.isFinite(n) && n > 0 ? n : RETRY_BASE_DELAY_MS_DEFAULT;
}

/**
 * HTTP status codes we treat as "transient — try again":
 *   408 Request Timeout
 *   425 Too Early (rare but transient)
 *   429 Too Many Requests (rate-limit from UPSTREAM — distinct from our own
 *       budget/loop 429s, which never reach this code path)
 *   500–599 server errors
 * 4xx other than the above is a real client error and won't go away by
 * retrying — bad model name, malformed body, auth failure, etc.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status < 600;
}

/**
 * Network-level errors thrown by `fetch` are retryable. Bun / undici surface
 * the original `code` either on `err` directly or on `err.cause`.
 *
 * Conservative list: connection refused, reset, timed out, DNS hiccups,
 * undici's named errors. We deliberately do NOT retry on AbortError —
 * that means our caller decided to bail and we should respect that.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    name?: string;
    code?: string;
    cause?: { code?: string; name?: string };
  };
  if (e.name === "AbortError") return false;
  const code = e.code ?? e.cause?.code;
  if (!code) return false;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENETDOWN" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

/**
 * Exponential backoff with full jitter (AWS-style):
 *   delay = random(0, baseMs * 2^attempt)
 * `attempt` is 0-indexed, so the first retry waits 0..baseMs, the second
 * waits 0..2*baseMs, etc. Capped at 5 seconds to keep tail latency sane.
 */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  const cap = Math.min(baseMs * 2 ** attempt, 5_000);
  return Math.floor(Math.random() * cap);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Look up the failover target for `originalModel`. Returns the failover model
 * name, or null if no mapping exists.
 *
 * Mappings are exact-match on the model name as seen post-routing. So
 * `gpt-4o=>claude-3-5-sonnet-latest` triggers when the body's `model` is
 * `gpt-4o` after our own router has already had its say.
 */
export function lookupFailover(originalModel: string): string | null {
  const m = getFailoverMap();
  return m.get(originalModel) ?? null;
}

// =========================================================================
// v0.6.7 — auto-fallback when a baseline-rewritten model 4xxs upstream
// =========================================================================
//
// Motivating failure: a baseline policy rewrote a caller's provider-specific
// model id to a stale generic model id. Upstream returned a
// `model_not_found`-shaped 4xx and the caller saw a hard failure. The user's
// intent was unambiguous: they asked for a model the upstream could serve, the
// gateway second-guessed them with a substitution, and the substitution was
// upstream-invalid. Right behavior:
// when the rewrite fails with a "model is the problem" 4xx, retry ONCE
// with the caller's original model — the routing decision is what failed,
// not the user's intent.
//
// Narrow gate so we don't over-retry on legitimate 4xxs (content-policy
// violations, malformed messages array, generic auth failures unrelated
// to the model swap):
//   - status MUST be 400, 401, 403, or 404. 401/403 included because some
//     upstreams reject unknown model names with an access-denied shape rather than the
//     more idiomatic 400 / 404 — the user's INTENT is unambiguous (their
//     key works for `default-models`, the routed model just isn't in
//     that allowlist), so retrying with the original model is correct.
//     The body-text gate below filters out generic auth failures.
//   - response body text MUST contain BOTH the word "model" AND one of
//     {"not found", "invalid", "unknown", "does not exist", "no such",
//      "not supported", "not_found", "not allowed", "denied",
//      "no access"} — case-insensitive. The "model" mention is what
//     keeps a true auth 401 ("Invalid API key", no "model") out of the
//     retry path.
//
// The two-token pattern (model + access-shape) keeps us from retrying:
//   - "messages must be an array" (no "model")
//   - "content_policy_violation" (no "model")
//   - "invalid request: temperature must be in [0,2]" (has "invalid"
//     but no "model")
//   - "Invalid API key" / 401 (no "model" → auth failure, won't be
//     fixed by trying a different model name)
//   - "rate limit reached" / 429 (handled separately by the existing
//     transient-retry layer; never reaches this gate)
// And catches:
//   - OpenAI: "The model `xyz` does not exist or you do not have access"
//   - OpenAI-compatible proxy 400: "Unknown model: gpt-5.2"
//   - OpenAI-compatible proxy 401: "key not allowed to access model. This key
//     can only access models=['default-models']. Tried to access ..."
//   - Anthropic: "model: claude-99 is not a recognized model"
//   - DeepSeek/Qwen/Doubao: similar ".. model .. invalid/unknown ..."
//
// Operator escape hatch: TOKENSMART_REWRITE_FALLBACK_ENABLED=0 disables
// the entire phase. Default ON because the failure mode is subtle and
// the upside is "request 200s instead of 401s" with no extra cost.
const REWRITE_FALLBACK_PATTERNS = [
  "not found",
  "not_found",
  "invalid",
  "unknown",
  "does not exist",
  "no such",
  "not supported",
  // "not allowed" + "denied" + "no access" catch access-shape variants
  // without false-positive on plain auth failures (those don't mention
  // "model" at all).
  "not allowed",
  "denied",
  "no access",
];

const REWRITE_FALLBACK_STATUSES = new Set([400, 401, 403, 404]);

export function isRewriteFailure4xx(status: number, body: unknown): boolean {
  if (!REWRITE_FALLBACK_STATUSES.has(status)) return false;
  if (body == null) return false;
  let text: string;
  try {
    text = (typeof body === "string" ? body : JSON.stringify(body)).toLowerCase();
  } catch {
    // Body had a circular reference or non-serializable shape — bail.
    // We won't retry; the caller sees the original 4xx.
    return false;
  }
  if (!text.includes("model")) return false;
  return REWRITE_FALLBACK_PATTERNS.some((p) => text.includes(p));
}

/**
 * Whether to attempt the v0.6.7 rewrite-failure auto-fallback at all.
 * Reads env each call so a test or runtime flip via `set-alert`-style
 * scripting takes effect without a restart. Default ON.
 */
export function rewriteFallbackEnabled(): boolean {
  const raw = process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED;
  return raw !== "0" && raw?.toLowerCase() !== "false";
}
