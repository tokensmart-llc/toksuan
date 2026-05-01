import { cookies } from "next/headers";
import { randomBytes, randomInt } from "node:crypto";
import { findUserIdByReferralCode, setReferredBy, sql } from "./db";
import { isEmailConfigured, sendLoginEmail } from "./email";
import { LOCALE_COOKIE } from "./i18n";

export { isEmailConfigured };

export const SESSION_COOKIE = "tokensmart_session";
const REFERRAL_COOKIE = "ts_ref";
const SESSION_DAYS = 30;
const OTP_DIGITS = 6;
const OTP_TTL_MIN = 15;

export type User = {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  /**
   * Soft-delete timestamp (v0.4.x). Non-NULL = the user has requested
   * account deletion; the row will be hard-deleted 30 days later by
   * the `sweep-deleted-users` cron unless they cancel. During the
   * grace window they stay logged-in but see a warning banner.
   */
  deleted_at: Date | null;
};

export function isAuthEnabled(): boolean {
  return process.env.TOKENSMART_AUTH_ENABLED === "1";
}

function shouldLogLoginCodes(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.TOKENSMART_LOG_LOGIN_CODES === "1"
  );
}

/** Refresh the session's `expires_at` back to `NOW() + SESSION_DAYS`
 *  when the remaining lifetime has dropped below this threshold. This
 *  gives the UX sliding-window semantics ("logged-in-while-active")
 *  without a DB write on every page view. */
const SESSION_REFRESH_THRESHOLD_MS =
  SESSION_DAYS * 24 * 60 * 60 * 1000 * 0.5;

/**
 * Current signed-in user, or null. Always returns null when auth is disabled
 * so callers can safely treat both modes uniformly.
 *
 * Sliding window: if the session still has more than `SESSION_DAYS/2`
 * of life left, we leave the row alone (most common path, zero writes).
 * When the remaining lifetime drops below half, we bump `expires_at`
 * back to `NOW() + SESSION_DAYS` AND rewrite the session cookie's
 * `Max-Age` so the browser keeps it too. An active user never has their
 * session expire mid-workflow; an inactive user's session still ages
 * out after a full `SESSION_DAYS` of silence.
 */
export async function getSession(): Promise<{ user: User; token: string } | null> {
  if (!isAuthEnabled()) return null;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await sql<(User & { expires_at: Date })[]>`
    SELECT u.id, u.email, u.name, u.plan, u.deleted_at, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token}
      AND s.expires_at > NOW()
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const { expires_at, ...user } = rows[0];

  // Sliding-window refresh on the DB side. Middleware handles the
  // client-cookie Max-Age refresh on every authed request (cookies()
  // in a server component is read-only under Next 15 — writes are
  // only allowed from server actions, route handlers, or middleware).
  //
  // Only writes to the DB when remaining lifetime is under half, so
  // most page loads are zero DB writes. Fire-and-forget on failure:
  // the session still works until the old expires_at — the user just
  // re-authenticates one cycle later than ideal.
  const msLeft = new Date(expires_at).getTime() - Date.now();
  if (msLeft < SESSION_REFRESH_THRESHOLD_MS) {
    try {
      await sql`
        UPDATE sessions
           SET expires_at = NOW() + (${SESSION_DAYS} || ' days')::INTERVAL
         WHERE token = ${token}
      `;
    } catch (err) {
      console.warn(
        "[tokensmart-auth] session refresh failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  return { user, token };
}

/**
 * User-facing project IDs. Call this in every auth-gated page and pass the
 * result to the db query functions so one user never sees another's rows.
 * Returns `undefined` when auth is disabled, meaning "no scoping, show
 * everything" — keep that behavior consistent across all db helpers.
 *
 * Visibility (post-migration 011):
 *   - Personal projects (projects.user_id = me)
 *   - Org-shared projects (projects.organization_id ∈ orgs I'm a member of)
 *
 * UNION-DISTINCT on the SQL side so a project that's both flagged
 * (legacy + transferred mid-flight) only appears once.
 */
export async function getScope(): Promise<string[] | undefined> {
  if (!isAuthEnabled()) return undefined;
  const session = await getSession();
  if (!session) return [];
  const rows = await sql<{ id: string }[]>`
    SELECT DISTINCT id FROM (
      SELECT id FROM projects WHERE user_id = ${session.user.id}
      UNION
      SELECT p.id
        FROM projects p
        JOIN organization_members m ON m.organization_id = p.organization_id
       WHERE m.user_id = ${session.user.id}
    ) AS visible
  `;
  return rows.map((r) => r.id);
}

// --- Magic links + sessions ------------------------------------------------

export type CreatedMagicLink = {
  email: string;
  code: string;
  token: string;
  ttlMinutes: number;
};

/**
 * Create a one-time login attempt for `email`.
 *
 * Dev installs can print the OTP + magic link to stdout so local testing
 * works without email. Production suppresses plaintext login secrets unless
 * an operator explicitly opts in with TOKENSMART_LOG_LOGIN_CODES=1. When
 * `RESEND_API_KEY` is present, we additionally send the code to the user's
 * inbox. Send failures are logged, not thrown: a broken email provider must
 * never be able to lock users out of signup.
 */
export async function startLogin(
  email: string,
  nextPath?: string
): Promise<CreatedMagicLink> {
  const normalized = email.trim().toLowerCase();
  const token = randomBytes(32).toString("hex");
  const code = String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, "0");
  await sql`
    INSERT INTO magic_links (email, token, code, expires_at)
    VALUES (
      ${normalized}, ${token}, ${code},
      NOW() + (${OTP_TTL_MIN} || ' minutes')::INTERVAL
    )
  `;
  const linkPath =
    nextPath && nextPath !== "/"
      ? `/login/verify?token=${token}&next=${encodeURIComponent(nextPath)}`
      : `/login/verify?token=${token}`;
  if (shouldLogLoginCodes()) {
    console.log(
      `[tokensmart-auth] login attempt for ${normalized}\n` +
        `  OTP  : ${code}\n` +
        `  link : ${linkPath}\n` +
        `  (valid for ${OTP_TTL_MIN} minutes)`
    );
  }

  if (isEmailConfigured()) {
    // Pick locale from the request cookie so the welcome email matches
    // the language the user was seeing in their browser when they hit
    // "send code". For brand-new signups (no DB row yet) the cookie is
    // the only signal we have; subsequent sign-ins use the same path
    // because we don't gain anything by reading `users.preferred_locale`
    // — the cookie write happens at every `setLocaleAction`, so it's
    // always at least as fresh.
    let locale: string | null = null;
    try {
      const store = await cookies();
      locale = store.get(LOCALE_COOKIE)?.value ?? null;
    } catch {
      // cookies() works only inside a request scope; fall through to
      // English when this is called outside one (e.g. from a script).
    }
    const result = await sendLoginEmail({
      to: normalized,
      code,
      token,
      ttlMinutes: OTP_TTL_MIN,
      nextPath,
      locale,
    });
    if (!result.ok) {
      console.error(`[tokensmart-auth] email delivery failed: ${result.error}`);
    }
  }

  return { email: normalized, code, token, ttlMinutes: OTP_TTL_MIN };
}

export type ConsumeArgs = { token: string } | { email: string; code: string };

/**
 * Consume a magic link either by click-token or by email+OTP. Returns the
 * corresponding user (creating one on first login for that email).
 *
 * The very first user created in an empty DB claims any pre-existing
 * un-owned project. That's how a self-hoster who enables auth after the
 * fact doesn't lose access to their existing data.
 */
export async function consumeLogin(args: ConsumeArgs): Promise<User | null> {
  let row: { email: string } | undefined;
  if ("token" in args) {
    const rows = await sql<{ email: string }[]>`
      UPDATE magic_links
         SET consumed_at = NOW()
       WHERE token = ${args.token}
         AND consumed_at IS NULL
         AND expires_at > NOW()
      RETURNING email
    `;
    row = rows[0];
  } else {
    const email = args.email.trim().toLowerCase();
    const rows = await sql<{ email: string }[]>`
      UPDATE magic_links
         SET consumed_at = NOW()
       WHERE id = (
         SELECT id FROM magic_links
          WHERE email = ${email}
            AND code = ${args.code}
            AND consumed_at IS NULL
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
       )
      RETURNING email
    `;
    row = rows[0];
  }
  if (!row) return null;

  const existing = await sql<User[]>`
    SELECT id, email, name, plan, deleted_at FROM users WHERE email = ${row.email} LIMIT 1
  `;
  if (existing[0]) return existing[0];

  const created = await sql<User[]>`
    INSERT INTO users (email) VALUES (${row.email})
    RETURNING id, email, name, plan, deleted_at
  `;
  const user = created[0]!;

  // First-ever user claims any orphaned projects + dev seed data so
  // "enable auth later" doesn't strand the existing dashboard view.
  const count = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM users`;
  if (count[0].c === 1) {
    await sql`UPDATE projects SET user_id = ${user.id} WHERE user_id IS NULL`;
  }

  return user;
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await sql`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (${token}, ${userId}, NOW() + (${SESSION_DAYS} || ' days')::INTERVAL)
  `;
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/**
 * Consume the `ts_ref` cookie set by middleware (when the user landed via
 * `?ref=<code>`) and attribute the referrer on the user row. Idempotent —
 * `setReferredBy` is a guarded UPDATE that only writes when the field is
 * still NULL, so login-twice doesn't re-attribute. Always clears the
 * cookie after to keep state tidy.
 *
 * Best-effort: any failure logs and returns. We never block the login
 * path on referral plumbing.
 */
export async function attributeReferralFromCookie(
  userId: string
): Promise<void> {
  try {
    const store = await cookies();
    const code = store.get(REFERRAL_COOKIE)?.value;
    if (!code) return;
    store.delete(REFERRAL_COOKIE);
    const referrerId = await findUserIdByReferralCode(code);
    if (!referrerId) return;
    const set = await setReferredBy(userId, referrerId);
    if (set) {
      console.log(
        `[tokensmart-auth] attributed referral: user ${userId} ← referrer ${referrerId} (code ${code})`
      );
    }
  } catch (err) {
    console.warn(
      "[tokensmart-auth] referral attribution failed:",
      err instanceof Error ? err.message : err
    );
  }
}

// --- Project ownership helpers --------------------------------------------

/**
 * `true` iff the user is allowed to MUTATE the project. After migration 011
 * that means EITHER the user owns it personally OR they're a non-viewer
 * member of the org that owns it.
 *
 * The viewer-role check is intentionally here (not at the action layer):
 * one chokepoint = one place to forget. Action-layer code that needs a
 * stricter check (e.g. "admin only") still bypasses this and queries
 * `getMemberRole` directly.
 */
export async function userOwnsProject(
  userId: string,
  projectId: string | null
): Promise<boolean> {
  if (!projectId) return false;
  const rows = await sql<{ source: "user" | "org"; role: string | null }[]>`
    SELECT 'user'::text AS source, NULL::text AS role
      FROM projects WHERE id = ${projectId} AND user_id = ${userId}
    UNION ALL
    SELECT 'org'::text AS source, m.role
      FROM projects p
      JOIN organization_members m ON m.organization_id = p.organization_id
     WHERE p.id = ${projectId} AND m.user_id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return false;
  if (row.source === "user") return true;
  // Viewer cannot mutate.
  return row.role !== "viewer";
}
