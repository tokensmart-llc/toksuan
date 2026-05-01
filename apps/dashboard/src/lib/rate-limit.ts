/**
 * Lightweight in-process rate limits for the auth surface.
 *
 * Why not Redis: we don't have it yet, and adding it for three
 * counters is premature. The process-local fallback is good enough
 * at current scale — loses counters on restart (a determined attacker
 * could time their flood around deploys, but that's a noisy signal
 * that surfaces in logs anyway).
 *
 * DB-backed throttles for the email-scoped counters use `magic_links`
 * as the sliding-window source-of-truth — no new migration. IP-scoped
 * counters live in this module's in-memory maps; we accept the
 * rebuild-on-restart tradeoff.
 *
 * Promote to Redis (or a dedicated `auth_rate_limits` table) when:
 *   - we horizontally scale the dashboard, OR
 *   - a real attack exhausts the in-process map.
 */

import { sql } from "./db";

// =========================================================================
// OTP REQUEST THROTTLE (per email, DB-backed)
// =========================================================================

const REQUEST_WINDOW_SECONDS = 60;
const REQUEST_MAX_PER_EMAIL_PER_WINDOW = 3;

/**
 * Returns `{ allowed: false, retryAfterSeconds }` when the given email
 * has already requested `REQUEST_MAX_PER_EMAIL_PER_WINDOW` OTPs in the
 * last `REQUEST_WINDOW_SECONDS` seconds. Lets through otherwise.
 *
 * Deliberately NOT a hard fail — we return a reason so the caller can
 * surface a helpful message ("you already asked for a code 20s ago;
 * check your spam folder") instead of a generic "error".
 */
export async function checkOtpRequestLimit(
  email: string
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const normalized = email.trim().toLowerCase();
  const rows = await sql<{ count: number; earliest: Date | null }[]>`
    SELECT
      COUNT(*)::int AS count,
      MIN(created_at) AS earliest
    FROM magic_links
    WHERE email = ${normalized}
      AND created_at > NOW() - (${REQUEST_WINDOW_SECONDS} || ' seconds')::INTERVAL
  `;
  const { count, earliest } = rows[0] ?? { count: 0, earliest: null };
  if (count < REQUEST_MAX_PER_EMAIL_PER_WINDOW) return { allowed: true };
  // Wait until the earliest-in-window row drops out of the window.
  const earliestTs = earliest ? new Date(earliest).getTime() : Date.now();
  const retryAt = earliestTs + REQUEST_WINDOW_SECONDS * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return { allowed: false, retryAfterSeconds };
}

// =========================================================================
// OTP VERIFY-FAILURE THROTTLE (per email, in-memory)
// =========================================================================

const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_MAX_FAILURES_PER_WINDOW = 10;

type FailureBucket = { failures: number; lockedUntilMs: number };
const failedVerifyMap = new Map<string, FailureBucket>();

/**
 * Call BEFORE attempting to consume the OTP. Returns blocked=true if
 * the email has burned through its verify budget; the caller should
 * refuse without hitting the DB (saves the brute-forcer nothing but
 * keeps our query load flat).
 */
export function isOtpVerifyLocked(email: string): {
  locked: boolean;
  retryAfterSeconds: number;
} {
  const key = email.trim().toLowerCase();
  pruneExpired(failedVerifyMap);
  const bucket = failedVerifyMap.get(key);
  if (!bucket) return { locked: false, retryAfterSeconds: 0 };
  if (bucket.lockedUntilMs > Date.now()) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil(
        (bucket.lockedUntilMs - Date.now()) / 1000
      ),
    };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

/**
 * Call AFTER a verify attempt. Increments the failure counter; if
 * the threshold is crossed, locks the email for a full window.
 * Successful verifies should call `resetOtpVerifyFailures` instead
 * so a legitimate user isn't penalised for a typo.
 */
export function recordOtpVerifyFailure(email: string): void {
  const key = email.trim().toLowerCase();
  const bucket = failedVerifyMap.get(key);
  const now = Date.now();
  if (!bucket || bucket.lockedUntilMs < now - VERIFY_WINDOW_MS) {
    failedVerifyMap.set(key, { failures: 1, lockedUntilMs: 0 });
    return;
  }
  bucket.failures += 1;
  if (bucket.failures >= VERIFY_MAX_FAILURES_PER_WINDOW) {
    bucket.lockedUntilMs = now + VERIFY_WINDOW_MS;
  }
}

export function resetOtpVerifyFailures(email: string): void {
  failedVerifyMap.delete(email.trim().toLowerCase());
}

// =========================================================================
// IP-SCOPED COARSE THROTTLE (in-memory)
// =========================================================================

const IP_WINDOW_MS = 60 * 1000;
const IP_MAX_EVENTS_PER_WINDOW = 20;

type IpBucket = { events: number[]; lockedUntilMs: number };
const ipMap = new Map<string, IpBucket>();

/**
 * Coarse per-IP rate limit across the entire auth surface. Catches
 * bulk enumeration attacks (a single IP trying 1000 emails). Doesn't
 * hurt a legitimate team behind one NAT — 20 auth actions / minute
 * from one IP is already an unusual shape.
 *
 * Returns `allowed=false` once the window is saturated; the caller
 * should return a generic 429 without disclosing what actually hit
 * the threshold.
 */
export function checkAuthIpLimit(ip: string | null): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  if (!ip) return { allowed: true, retryAfterSeconds: 0 };
  const now = Date.now();
  pruneExpired(ipMap);
  let bucket = ipMap.get(ip);
  if (!bucket) {
    bucket = { events: [], lockedUntilMs: 0 };
    ipMap.set(ip, bucket);
  }
  if (bucket.lockedUntilMs > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.lockedUntilMs - now) / 1000),
    };
  }
  bucket.events = bucket.events.filter((t) => t > now - IP_WINDOW_MS);
  if (bucket.events.length >= IP_MAX_EVENTS_PER_WINDOW) {
    bucket.lockedUntilMs = now + IP_WINDOW_MS;
    return { allowed: false, retryAfterSeconds: Math.ceil(IP_WINDOW_MS / 1000) };
  }
  bucket.events.push(now);
  return { allowed: true, retryAfterSeconds: 0 };
}

// =========================================================================
// Internal utility
// =========================================================================

/**
 * Drop expired buckets so the in-memory maps can't grow unbounded over
 * a long-running process. Linear scan is fine at the scales we expect
 * (unique IPs per minute × TTL) — thousands of entries at most.
 */
function pruneExpired<K, V extends { lockedUntilMs: number }>(
  m: Map<K, V>
): void {
  if (m.size < 1000) return;
  const now = Date.now();
  // Allow two windows of headroom so a bucket re-entering the window
  // doesn't get double-counted as fresh.
  const cutoff = now - Math.max(VERIFY_WINDOW_MS, IP_WINDOW_MS) * 2;
  for (const [k, v] of m) {
    if (v.lockedUntilMs < cutoff) m.delete(k);
  }
}
