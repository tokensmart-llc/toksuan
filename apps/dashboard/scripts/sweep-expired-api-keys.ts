#!/usr/bin/env bun
/**
 * Hard-delete api_keys rows whose soft-rotate grace window has elapsed.
 *
 * Why this exists: v0.4.x added soft-rotate with a 24h grace period
 * (migration 014 + `api_keys.expires_at`). The gateway already treats
 * expired keys as invalid via `findApiKey`'s `expires_at > NOW()`
 * filter, so correctness doesn't depend on this sweep running — but
 * without it, expired rows accumulate and the UI's key list gets
 * noisy. A daily pass keeps things tidy.
 *
 * Designed for:
 *   - GitHub Actions cron (`.github/workflows/sweep-api-keys.yml`)
 *   - Fly Machines schedule / Railway cron
 *   - Plain crontab: `0 3 * * * bun run sweep-expired-api-keys`
 *
 * Idempotent. Exit 0 on success (any count, including 0). Exit 1 only
 * on DB-unreachable or other fatal error.
 */

import { sql, sweepExpiredApiKeys } from "../src/lib/db";

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log("[sweep-expired-api-keys] starting");

  const deleted = await sweepExpiredApiKeys();

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[sweep-expired-api-keys] done — deleted=${deleted} elapsed=${elapsedMs}ms`
  );

  // Best-effort ops-audit row so operators can confirm the cron ran,
  // even if nothing needed to be swept.
  try {
    await sql`
      INSERT INTO ops_audit_events (
        user_id, event, target_type, target_id, actor, metadata, ip
      ) VALUES (
        NULL,
        ${"api_key.soft_rotate_sweep"},
        ${"api_keys"},
        NULL,
        ${"cron"},
        ${sql.json({
          deleted,
          elapsed_ms: elapsedMs,
        } as Parameters<typeof sql.json>[0])},
        NULL
      )
    `;
  } catch (err) {
    console.warn(
      "[sweep-expired-api-keys] ops_audit_events insert failed:",
      err instanceof Error ? err.message : err
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[sweep-expired-api-keys] fatal:", err);
  process.exit(1);
});
