/**
 * Runtime mode detection — "am I the hosted SaaS at tokensmt.com, or
 * am I somebody's self-hosted dev box?"
 *
 * Why this exists: several UI surfaces carry copy that's perfect for
 * OSS self-hosters but reads broken to a paying hosted customer. Two
 * concrete examples:
 *
 *   - /login footer says "OTP is also printed to the dashboard server
 *     console for dev". A hosted user reading that assumes email is
 *     down and opens a ticket.
 *   - /settings Weekly digest card says "cron operator must run
 *     `bun run send-weekly-savings`". A hosted user reading that
 *     thinks the feature is broken or operator-gated.
 *
 * The fix is to key those copy branches on `isHostedMode()` so the
 * OSS wording stays for self-hosters and hosted customers see the
 * customer-appropriate version.
 *
 * Judgement: a single explicit env var is the right knob. We
 * deliberately do NOT infer hosted mode from "is there a Stripe key"
 * or "is auth enabled" — those are both true on some self-hosted
 * production deploys. A dedicated flag makes operator intent
 * unambiguous.
 *
 * Convention:
 *   TOKENSMART_HOSTED_MODE=1   → hosted SaaS at tokensmt.com
 *   TOKENSMART_HOSTED_MODE=0   → OSS / self-host (default)
 *   (unset)                    → OSS / self-host (default)
 *
 * When in doubt, leave it unset — showing the operator-audience copy to
 * a hosted customer is strictly worse than the reverse.
 */

export function isHostedMode(): boolean {
  return process.env.TOKENSMART_HOSTED_MODE === "1";
}

/**
 * The next scheduled weekly-digest send, in UTC. Hosted deploys run this
 * via `.github/workflows/weekly-digest.yml` — Monday 10:00 UTC per that
 * file's cron. We hardcode that same anchor here (instead of parsing the
 * yaml or probing GitHub) because the whole point is to print a
 * customer-friendly "your next email is at X" sentence, and the schedule
 * changes approximately never.
 *
 * If the operator ever changes the schedule, override via the
 * TOKENSMART_WEEKLY_DIGEST_CRON_ANCHOR env var (format `DAY:HH:MM` UTC
 * where DAY is 0–6 with 0=Sunday, 1=Monday, …). Not documented anywhere
 * user-facing on purpose — this is ops-side.
 */
export function nextWeeklyDigestSendUtc(now: Date = new Date()): Date {
  // Parse optional override.
  const override = process.env.TOKENSMART_WEEKLY_DIGEST_CRON_ANCHOR;
  let targetDow = 1; // Monday
  let targetHour = 10;
  let targetMin = 0;
  if (override) {
    const m = /^([0-6]):(\d{1,2}):(\d{1,2})$/.exec(override);
    if (m) {
      targetDow = Number(m[1]);
      targetHour = Number(m[2]);
      targetMin = Number(m[3]);
    }
  }

  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      targetHour,
      targetMin,
      0,
      0
    )
  );
  // Walk forward until we're on the right day AND strictly after `now`.
  while (next.getUTCDay() !== targetDow || next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
