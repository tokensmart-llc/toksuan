#!/usr/bin/env bun
/**
 * Hard-delete expired `sessions` + consumed / expired `magic_links`
 * rows so they don't accumulate indefinitely.
 *
 * Why it exists. Every successful login writes a `sessions` row with
 * a 30-day expiry, and every OTP attempt writes a `magic_links` row
 * with a 15-minute TTL. The gateway + dashboard filter both by
 * `expires_at > NOW()` at read time, so correctness doesn't depend on
 * this sweep — but without it:
 *   - `sessions` grows ~1 row per login forever (an active 1000-user
 *     hosted deployment adds ~30k rows / month of dead weight)
 *   - `magic_links` grows ~1 row per OTP request, including the many
 *     spam attempts that the rate-limiter now gates
 *   - CI / SOC-2 reviewers ask "what's your tombstone TTL policy?" —
 *     having no answer is worse than having "daily sweep, 30d grace"
 *
 * Policy (generous, matches industry-standard):
 *   - `sessions`     : delete once `expires_at` passed >= 30 days ago
 *   - `magic_links`  : delete once `expires_at` passed >= 7 days ago
 *                       (short grace so "didn't get the email, asking
 *                       support what happened" has a forensic trail)
 *
 * NOT swept (by design):
 *   - Active (still-valid) rows
 *   - Recently expired rows within the grace window above
 *   - `audit_events` (3-yr retention per SOC-2)
 *
 * Designed for a daily cron. Idempotent (re-runs after a full sweep
 * are no-ops). Writes an `auth.tombstone_sweep` ops_audit_events row
 * each pass so operators can confirm the cron is alive.
 *
 * Flags:
 *   --dry-run   count + log, don't delete
 */

import { sql } from "../src/lib/db";

type Args = { dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run sweep-expired-auth [--dry-run]");
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();
  console.log(
    `[sweep-expired-auth] starting${args.dryRun ? " (dry-run)" : ""}`
  );

  // Count eligible rows first — two tables, one query each.
  const [sessCount, mlCount] = await Promise.all([
    sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM sessions
       WHERE expires_at < NOW() - INTERVAL '30 days'
    `,
    sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM magic_links
       WHERE expires_at < NOW() - INTERVAL '7 days'
    `,
  ]);
  const eligibleSessions = Number(sessCount[0]?.count ?? 0);
  const eligibleMagicLinks = Number(mlCount[0]?.count ?? 0);

  let deletedSessions = 0;
  let deletedMagicLinks = 0;

  if (!args.dryRun) {
    const sessRows = await sql<{ deleted: number }[]>`
      DELETE FROM sessions
       WHERE expires_at < NOW() - INTERVAL '30 days'
      RETURNING 1 AS deleted
    `;
    deletedSessions = sessRows.length;

    const mlRows = await sql<{ deleted: number }[]>`
      DELETE FROM magic_links
       WHERE expires_at < NOW() - INTERVAL '7 days'
      RETURNING 1 AS deleted
    `;
    deletedMagicLinks = mlRows.length;
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[sweep-expired-auth] done — sessions=${deletedSessions} magic_links=${deletedMagicLinks} eligible=${eligibleSessions + eligibleMagicLinks} elapsed=${elapsedMs}ms${args.dryRun ? " (dry-run)" : ""}`
  );

  try {
    await sql`
      INSERT INTO ops_audit_events (
        user_id, event, target_type, target_id, actor, metadata, ip
      ) VALUES (
        NULL,
        ${args.dryRun ? "auth.tombstone_sweep_dry_run" : "auth.tombstone_sweep"},
        ${"auth"},
        NULL,
        ${"cron"},
        ${sql.json({
          eligible_sessions: eligibleSessions,
          eligible_magic_links: eligibleMagicLinks,
          deleted_sessions: deletedSessions,
          deleted_magic_links: deletedMagicLinks,
          elapsed_ms: elapsedMs,
        } as Parameters<typeof sql.json>[0])},
        NULL
      )
    `;
  } catch (err) {
    console.warn(
      "[sweep-expired-auth] ops_audit_events insert failed:",
      err instanceof Error ? err.message : err
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[sweep-expired-auth] fatal:", err);
  process.exit(1);
});
