import { randomBytes } from "node:crypto";
import { sql } from "./db";

/**
 * Per-user unsubscribe-token machinery for transactional-list emails.
 * Migration 018 adds `users.unsubscribe_token TEXT`. We lazy-mint a
 * 256-bit random hex token the first time we need a link for that
 * user, then reuse it forever — the link in an email sent today still
 * works months later (subject to the user not rotating).
 *
 * One token per user (not per list) — we identify the list via a
 * `list=` query param, so `weekly_digest`, future `incident_notices`,
 * `announcements` etc. all reuse the same token. That's fine because
 * token compromise is already a full-account compromise (unsubscribe
 * is the most damaging op anyway, and it's trivially reversible from
 * /settings).
 */

export type UnsubscribableList = "weekly_digest";

const ALLOWED_LISTS: UnsubscribableList[] = ["weekly_digest"];

export function isUnsubscribableList(v: string): v is UnsubscribableList {
  return (ALLOWED_LISTS as string[]).includes(v);
}

/**
 * Returns the user's unsubscribe token, minting + persisting a fresh
 * one if the row doesn't have one yet. Idempotent — concurrent callers
 * race the `UPDATE ... WHERE unsubscribe_token IS NULL` and whoever
 * loses picks up the winning token on the subsequent SELECT.
 */
export async function getOrCreateUnsubscribeToken(
  userId: string
): Promise<string> {
  const existing = await sql<{ unsubscribe_token: string | null }[]>`
    SELECT unsubscribe_token FROM users WHERE id = ${userId} LIMIT 1
  `;
  if (existing[0]?.unsubscribe_token) return existing[0].unsubscribe_token;

  const fresh = randomBytes(32).toString("hex");
  const updated = await sql<{ unsubscribe_token: string }[]>`
    UPDATE users
       SET unsubscribe_token = ${fresh}
     WHERE id = ${userId}
       AND unsubscribe_token IS NULL
    RETURNING unsubscribe_token
  `;
  if (updated[0]?.unsubscribe_token) return updated[0].unsubscribe_token;

  // Lost the race — re-read.
  const second = await sql<{ unsubscribe_token: string | null }[]>`
    SELECT unsubscribe_token FROM users WHERE id = ${userId} LIMIT 1
  `;
  return second[0]?.unsubscribe_token ?? fresh;
}

export function buildUnsubscribeUrl(
  token: string,
  list: UnsubscribableList
): string {
  const base = (
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  ).replace(/\/+$/, "");
  const params = new URLSearchParams({ t: token, list });
  return `${base}/unsubscribe?${params.toString()}`;
}

/**
 * Look up the user by token and flip the right preference column.
 * Returns the user row (or null if token was invalid) so the page /
 * API route can render a confirmation with the masked email.
 */
export async function unsubscribeByToken(
  token: string,
  list: UnsubscribableList
): Promise<{ ok: true; email: string } | { ok: false }> {
  if (!token || token.length < 32) return { ok: false };
  // Single column flip per list — easy to extend when new lists land.
  if (list === "weekly_digest") {
    const rows = await sql<{ email: string }[]>`
      UPDATE users
         SET weekly_digest_enabled = FALSE
       WHERE unsubscribe_token = ${token}
       RETURNING email
    `;
    if (rows[0]) return { ok: true as const, email: rows[0].email };
    return { ok: false as const };
  }
  return { ok: false };
}
