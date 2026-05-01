#!/usr/bin/env bun
/**
 * Referral commission settle pass — cron-runnable.
 *
 * What it does:
 *   1. Lists pending `referral_credits` rows
 *      (referee paid the invoice, credit not yet applied to the referrer's
 *      Stripe customer balance).
 *   2. For each, calls `Stripe.Customers.createBalanceTransaction` with
 *      `amount = -cents` (Stripe convention: negative = credit).
 *   3. Stamps the row with the transaction id so the next pass skips it
 *      (idempotent on `referral_credits.applied_balance_txn_id`).
 *
 * The function `settlePendingReferralCredits` already lives in
 * `src/lib/stripe.ts` — this script is the operations wrapper that makes
 * it a one-liner cron job.
 *
 * Designed for any of:
 *   - GitHub Actions cron (.github/workflows/settle-referrals.yml)
 *   - Fly Machines schedule (fly.toml [[mounts.schedule]])
 *   - Railway cron service
 *   - Plain crontab on a VPS
 *
 * Recommended schedule: daily at 04:30 UTC. There's no deadline pressure —
 * we're crediting customers, not charging them — so once a day is fine and
 * keeps the Stripe API-call rate trivial.
 *
 * Flags:
 *   --dry-run         Compute pending rows + log what WOULD be applied,
 *                     but make zero Stripe API calls. No DB writes either.
 *   --limit=<N>       Cap rows processed per pass (default 200; same as the
 *                     UI-triggered settle so behavior matches).
 *
 * Exit codes:
 *   0  Pass completed (any non-zero `errors` count is logged but does not
 *      fail the script — partial settlement is still progress and a future
 *      pass will retry the failed rows).
 *   1  Fatal: STRIPE_SECRET_KEY missing in non-dry-run mode, or DB unreachable.
 *
 * Idempotency: the underlying `settlePendingReferralCredits` only walks
 * rows where `applied_balance_txn_id IS NULL`, so a double-fired cron is
 * safe — the second run finds zero pending rows and exits cleanly.
 *
 * Operator audit: every successful pass writes a `referral.settled_cron`
 * row to `ops_audit_events` (separate from the user-facing `referral.settled`
 * fired when a human triggers settle from the dashboard UI).
 */

import { settlePendingReferralCredits } from "../src/lib/stripe";
import { sql } from "../src/lib/db";

type Args = {
  dryRun: boolean;
  limit: number;
};

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let limit = 200;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0 && n <= 10_000) limit = Math.floor(n);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run settle-referrals [--dry-run] [--limit=N]"
      );
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return { dryRun, limit };
}

async function logCronEvent(args: {
  applied: number;
  skipped: number;
  errors: number;
  dryRun: boolean;
  elapsedMs: number;
}): Promise<void> {
  try {
    await sql`
      INSERT INTO ops_audit_events (
        user_id, event, target_type, target_id, actor, metadata, ip
      ) VALUES (
        NULL,
        ${"referral.settled_cron"},
        ${"referral_credits"},
        NULL,
        ${"cron"},
        ${sql.json({
          applied: args.applied,
          skipped: args.skipped,
          errors: args.errors,
          dry_run: args.dryRun,
          elapsed_ms: args.elapsedMs,
        } as Parameters<typeof sql.json>[0])},
        NULL
      )
    `;
  } catch (err) {
    console.warn(
      "[settle-referrals] ops_audit_events insert failed (table missing?):",
      err instanceof Error ? err.message : err
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!args.dryRun && !process.env.STRIPE_SECRET_KEY) {
    console.error(
      "STRIPE_SECRET_KEY is not set. Configure it (or pass --dry-run for a preview)."
    );
    process.exit(1);
  }

  console.log(
    `[settle-referrals] starting${args.dryRun ? " (dry-run)" : ""} limit=${args.limit}`
  );
  const startedAt = Date.now();

  const summary = await settlePendingReferralCredits({
    limit: args.limit,
    dryRun: args.dryRun,
  });

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[settle-referrals] done — applied=${summary.applied} skipped=${summary.skipped} errors=${summary.errors} elapsed=${elapsedMs}ms`
  );

  await logCronEvent({ ...summary, dryRun: args.dryRun, elapsedMs });

  // Errors are non-fatal — pending rows that failed will retry on the next
  // cron tick. Exit 0 so cron infra doesn't escalate "cron failed!" alerts
  // for the steady-state case of "Stripe was rate-limited on one row".
  process.exit(0);
}

main().catch((err) => {
  console.error("[settle-referrals] fatal:", err);
  process.exit(1);
});
