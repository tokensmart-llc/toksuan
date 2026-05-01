#!/usr/bin/env bun
/**
 * Weekly savings digest sender.
 *
 * Iterates every hosted user with at least one project, computes their last-7d
 * savings via the same SQL the dashboard uses, and sends a one-page email
 * summary via Resend.
 *
 * Designed to be invoked once a week from cron / fly cron / GitHub Actions:
 *
 *   # crontab — Mondays at 10:00 UTC
 *   0 10 * * 1   cd /opt/tokensmart/apps/dashboard && bun run send-weekly-savings
 *
 *   # OR via Fly Machines (fly.toml)
 *   [[services]]
 *     processes = ["weekly_digest"]
 *   [processes]
 *     weekly_digest = "bun run send-weekly-savings"
 *
 * Flags:
 *   --dry-run         Print what would be sent, don't actually send
 *   --to=<email>      Send only to this address (debug / smoke test)
 *   --min-saved=<n>   Skip users whose last-7d saving is below this many
 *                     micro_cents (default 0 — send to everyone with traffic)
 *
 * Exit codes:
 *   0  All sends succeeded (or dry-run completed)
 *   1  At least one send failed (other sends still attempted)
 *   2  Misconfigured (e.g. RESEND_API_KEY missing in non-dry-run mode)
 *
 * Idempotency: this script does NOT track who's been emailed when. If your
 * cron schedule double-fires, recipients get two emails. Add a `digest_sent`
 * table if that becomes a problem in production.
 */

import {
  getSavingsBreakdown,
  getTopRoutedPairs,
  listDigestRecipients,
  markWeeklyDigestSent,
} from "../src/lib/db";
import {
  isEmailConfigured,
  sendWeeklyDigestEmail,
} from "../src/lib/email";
import {
  buildUnsubscribeUrl,
  getOrCreateUnsubscribeToken,
} from "../src/lib/unsubscribe";

type Args = {
  dryRun: boolean;
  to: string | null;
  minSavedMicroCents: number;
};

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let to: string | null = null;
  let minSaved = 0;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
    else if (arg.startsWith("--min-saved=")) {
      const n = Number(arg.slice("--min-saved=".length));
      if (Number.isFinite(n) && n >= 0) minSaved = n;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run send-weekly-savings [--dry-run] [--to=email] [--min-saved=N]"
      );
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return { dryRun, to, minSavedMicroCents: minSaved };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!args.dryRun && !isEmailConfigured()) {
    console.error(
      "RESEND_API_KEY is not set. Configure it (or pass --dry-run for a preview)."
    );
    process.exit(2);
  }

  console.log(
    `[digest] starting${args.dryRun ? " (dry-run)" : ""}${args.to ? ` (to=${args.to})` : ""}`
  );

  const recipients = await listDigestRecipients();
  console.log(`[digest] ${recipients.length} hosted user(s) with projects`);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (const r of recipients) {
    if (args.to && r.email !== args.to) continue;
    if (r.project_ids.length === 0) {
      skipped++;
      continue;
    }

    try {
      const [breakdown, topRoutes] = await Promise.all([
        getSavingsBreakdown(168, r.project_ids),
        getTopRoutedPairs(168, 5, r.project_ids),
      ]);

      // Skip users with no traffic at all (avoid sending "you saved $0 this
      // week!" — that's just noise that hastens the unsubscribe). Skip
      // strictly below `--min-saved` if the operator wants to be even more
      // conservative.
      if (
        breakdown.total_spend_micro_cents === 0 ||
        breakdown.total_saving_micro_cents < args.minSavedMicroCents
      ) {
        console.log(
          `[digest] skip ${r.email}: spend=${breakdown.total_spend_micro_cents}μ¢ saved=${breakdown.total_saving_micro_cents}μ¢`
        );
        skipped++;
        continue;
      }

      const summary = `${r.email}: saved ${(breakdown.total_saving_micro_cents / 100_000).toFixed(4)} USD over ${(breakdown.total_spend_micro_cents / 100_000).toFixed(4)} USD spend, ${topRoutes.length} routed pair(s)`;

      if (args.dryRun) {
        console.log(`[digest] would send → ${summary}`);
        sent++;
        continue;
      }

      // Lazy-mint the unsubscribe token on first send (idempotent on
      // re-runs). The URL embedded in the email is stable forever
      // after that, so a user clicking an old message always works.
      const unsubToken = await getOrCreateUnsubscribeToken(r.user_id);
      const unsubscribeUrl = buildUnsubscribeUrl(unsubToken, "weekly_digest");

      const result = await sendWeeklyDigestEmail({
        to: r.email,
        recipientName: r.name,
        totalSavingMicroCents: breakdown.total_saving_micro_cents,
        routingSavingMicroCents: breakdown.routing_saving_micro_cents,
        cacheSavingMicroCents: breakdown.cache_saving_micro_cents,
        routingRequestCount: breakdown.routing_request_count,
        cacheHitCount: breakdown.cache_hit_count,
        loopsPreventedCount: breakdown.loops_prevented_count,
        budgetBlockedCount: breakdown.budget_blocked_count,
        totalSpendMicroCents: breakdown.total_spend_micro_cents,
        topRoutes,
        unsubscribeUrl,
        // Mirror of `users.preferred_locale` at scan time. NULL when
        // the user hasn't toggled the language switcher (or migration
        // 033 isn't applied yet) — `sendWeeklyDigestEmail` defaults to
        // English in that case.
        locale: r.preferred_locale,
      });

      if (result.ok) {
        // Stamp last_sent_at so the dashboard "Email preferences" toggle
        // can show "last sent X ago" — best-effort, don't fail send on
        // bookkeeping error.
        await markWeeklyDigestSent(r.user_id).catch((e) =>
          console.warn(`[digest] markSent fail ${r.email}:`, e)
        );
        console.log(`[digest] sent → ${summary}`);
        sent++;
      } else {
        console.error(`[digest] FAIL ${r.email}: ${result.error}`);
        failed++;
      }
    } catch (err) {
      console.error(
        `[digest] crash on ${r.email}:`,
        err instanceof Error ? err.message : err
      );
      failed++;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[digest] done — sent=${sent} skipped=${skipped} failed=${failed} elapsed=${elapsedMs}ms`
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[digest] fatal:", err);
  process.exit(2);
});
