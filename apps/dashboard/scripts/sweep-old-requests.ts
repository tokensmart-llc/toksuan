#!/usr/bin/env bun
/**
 * Enforce the "90-day rolling window on request bodies + A/B results"
 * retention promise in `SECURITY.md` § Data retention + DPA § 7.2.
 *
 * Why this exists. Request rows carry prompt text + response bodies,
 * which often contain PII (customer names in support agents, proprietary
 * code in IDE assistants, etc.). Holding them forever is a liability
 * spike + a GDPR § 5(1)(e) storage-limitation violation. Our public
 * retention table commits to 90 days for hosted; this script is the
 * enforcement mechanism. Before this script landed, SECURITY.md was
 * writing a check the repo couldn't cash.
 *
 * Scope:
 *   - `requests`    — every row older than `TOKENSMART_REQUEST_RETENTION_DAYS`
 *   - `ab_results`  — same window (shadow A/B rows are the same PII class)
 *
 * NOT swept here:
 *   - `audit_events`  — 3-yr SOC-2 retention, separate policy
 *   - `ops_audit_events` — operator-only, no PII
 *   - `magic_links` / `sessions` — handled by `sweep-expired-auth.ts`
 *
 * Self-host default: `TOKENSMART_REQUEST_RETENTION_DAYS` unset → script
 * exits without deleting anything. Self-hosters control their own
 * retention per `SECURITY.md#self-host`. Hosted tokensmt.com sets the
 * env var to `90`.
 *
 * Designed for:
 *   - Host crontab: `30 2 * * * bun run sweep-old-requests`
 *   - GitHub Actions / Fly Machines schedule / Railway cron / Kubernetes
 *     CronJob — any scheduler that can run the script daily.
 *
 * Deletes are done in batches so a single pass on a year of data
 * doesn't hold a giant transaction. Idempotent — re-running after
 * each batch is a no-op once the window is clean.
 *
 * Flags:
 *   --dry-run         Count rows that WOULD be deleted, skip the DELETE
 *   --days=N          Override TOKENSMART_REQUEST_RETENTION_DAYS at CLI
 *   --batch-size=N    Rows to delete per transaction (default 5000)
 *   --max-batches=N   Hard cap on batches in one run (default 200)
 *
 * Exit codes:
 *   0  swept or dry-run completed
 *   1  DB error
 *   2  misconfigured (e.g. unparseable --days)
 */

import { sql } from "../src/lib/db";

type Args = {
  dryRun: boolean;
  days: number | null;
  batchSize: number;
  maxBatches: number;
};

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let days: number | null = null;
  let batchSize = 5000;
  let maxBatches = 200;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--days=")) {
      const n = Number(arg.slice("--days=".length));
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        console.error(`invalid --days: ${arg}`);
        process.exit(2);
      }
      days = Math.floor(n);
    } else if (arg.startsWith("--batch-size=")) {
      const n = Number(arg.slice("--batch-size=".length));
      if (!Number.isFinite(n) || n < 100 || n > 100_000) {
        console.error(`invalid --batch-size: ${arg}`);
        process.exit(2);
      }
      batchSize = Math.floor(n);
    } else if (arg.startsWith("--max-batches=")) {
      const n = Number(arg.slice("--max-batches=".length));
      if (!Number.isFinite(n) || n < 1) {
        console.error(`invalid --max-batches: ${arg}`);
        process.exit(2);
      }
      maxBatches = Math.floor(n);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run sweep-old-requests [--dry-run] [--days=90] [--batch-size=5000] [--max-batches=200]"
      );
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  if (days == null) {
    const env = process.env.TOKENSMART_REQUEST_RETENTION_DAYS?.trim();
    if (env) {
      const n = Number(env);
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        console.error(
          `invalid TOKENSMART_REQUEST_RETENTION_DAYS=${env} (expected integer 1..3650)`
        );
        process.exit(2);
      }
      days = Math.floor(n);
    }
  }
  return { dryRun, days, batchSize, maxBatches };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.days == null) {
    console.log(
      "[sweep-old-requests] no retention window configured — set " +
        "TOKENSMART_REQUEST_RETENTION_DAYS or pass --days=N. Exiting 0."
    );
    process.exit(0);
  }

  const startedAt = Date.now();
  console.log(
    `[sweep-old-requests] starting${args.dryRun ? " (dry-run)" : ""} days=${args.days} batchSize=${args.batchSize}`
  );

  // Count what would be swept, both tables, for the before/after log.
  const [reqCount, abCount] = await Promise.all([
    sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM requests
       WHERE created_at < NOW() - (${args.days} || ' days')::INTERVAL
    `,
    sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM ab_results
       WHERE created_at < NOW() - (${args.days} || ' days')::INTERVAL
    `,
  ]);
  const eligibleRequests = Number(reqCount[0]?.count ?? 0);
  const eligibleAbResults = Number(abCount[0]?.count ?? 0);

  console.log(
    `[sweep-old-requests] eligible: requests=${eligibleRequests} ab_results=${eligibleAbResults}`
  );

  let deletedRequests = 0;
  let deletedAbResults = 0;

  if (!args.dryRun) {
    // Batch-delete requests. `ctid` subquery is the canonical Postgres
    // pattern for "delete top N matching rows" without needing an
    // explicit ORDER BY on a unique column (which here would need the
    // `id` PK, fine too, but ctid avoids an index sort on large tables).
    for (let i = 0; i < args.maxBatches; i++) {
      const rows = await sql<{ deleted: number }[]>`
        WITH victims AS (
          SELECT ctid FROM requests
           WHERE created_at < NOW() - (${args.days} || ' days')::INTERVAL
           LIMIT ${args.batchSize}
        )
        DELETE FROM requests WHERE ctid IN (SELECT ctid FROM victims)
        RETURNING 1 AS deleted
      `;
      const n = rows.length;
      deletedRequests += n;
      if (n === 0) break;
      if (i > 0 && i % 10 === 0) {
        console.log(
          `[sweep-old-requests] progress: requests deleted=${deletedRequests}`
        );
      }
    }

    for (let i = 0; i < args.maxBatches; i++) {
      const rows = await sql<{ deleted: number }[]>`
        WITH victims AS (
          SELECT ctid FROM ab_results
           WHERE created_at < NOW() - (${args.days} || ' days')::INTERVAL
           LIMIT ${args.batchSize}
        )
        DELETE FROM ab_results WHERE ctid IN (SELECT ctid FROM victims)
        RETURNING 1 AS deleted
      `;
      const n = rows.length;
      deletedAbResults += n;
      if (n === 0) break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[sweep-old-requests] done — requests=${deletedRequests} ab_results=${deletedAbResults} eligible=${
      eligibleRequests + eligibleAbResults
    } elapsed=${elapsedMs}ms${args.dryRun ? " (dry-run)" : ""}`
  );

  // Ops audit trail so operators can confirm the window is being
  // enforced — key signal for any SOC-2 / DPA review.
  try {
    await sql`
      INSERT INTO ops_audit_events (
        user_id, event, target_type, target_id, actor, metadata, ip
      ) VALUES (
        NULL,
        ${args.dryRun ? "request.retention_sweep_dry_run" : "request.retention_sweep"},
        ${"requests"},
        NULL,
        ${"cron"},
        ${sql.json({
          retention_days: args.days,
          eligible_requests: eligibleRequests,
          eligible_ab_results: eligibleAbResults,
          deleted_requests: deletedRequests,
          deleted_ab_results: deletedAbResults,
          elapsed_ms: elapsedMs,
          batch_size: args.batchSize,
          max_batches: args.maxBatches,
        } as Parameters<typeof sql.json>[0])},
        NULL
      )
    `;
  } catch (err) {
    console.warn(
      "[sweep-old-requests] ops_audit_events insert failed:",
      err instanceof Error ? err.message : err
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[sweep-old-requests] fatal:", err);
  process.exit(1);
});
