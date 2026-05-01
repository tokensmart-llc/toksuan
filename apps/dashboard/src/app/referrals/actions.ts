"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import { ensureReferralCode } from "@/lib/db";
import { settlePendingReferralCredits } from "@/lib/stripe";

async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}

async function actorIp(): Promise<string | null> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}

/**
 * Mint the user's referral code on demand. Idempotent — `ensureReferralCode`
 * returns the existing code if there already is one, so a double-click on
 * the button doesn't generate two codes (and the UNIQUE constraint would
 * prevent that anyway).
 */
export async function generateReferralCodeAction(): Promise<void> {
  const user = await requireUser();
  const code = await ensureReferralCode(user.id);
  await logAuditEvent({
    userId: user.id,
    actorEmail: user.email,
    event: "referral.code_minted",
    metadata: { code },
    ip: await actorIp(),
  });
  redirect(
    `/referrals?toast=referral-code-ready&toast_arg=${encodeURIComponent(code)}`
  );
}

/**
 * Operator-triggered settle: mints Stripe customer-balance credits for any
 * pending `referral_credits` rows. Triggered manually from the UI for now;
 * future iteration will wire this onto a cron (Fly Machines / GitHub
 * Actions) once we have enough volume to need it.
 *
 * Auth: any signed-in user can trigger; the action only credits THEIR
 * referees' invoices (no — wait, that's wrong, this drains the global
 * pending queue across all referrers). Restrict to a known operator email
 * via `TOKENSMART_OPS_EMAILS` (comma-separated) so a random Pro user can't
 * burn Stripe API quota on settles. Defaults to disabled when unset.
 */
export async function settleReferralCreditsAction(): Promise<void> {
  const user = await requireUser();
  const ops = (process.env.TOKENSMART_OPS_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!ops.includes(user.email.toLowerCase())) {
    redirect(`/referrals?toast=referral-settle-unauth`);
  }
  const summary = await settlePendingReferralCredits({ limit: 200 });
  await logAuditEvent({
    userId: user.id,
    actorEmail: user.email,
    event: "referral.settled",
    metadata: summary,
    ip: await actorIp(),
  });
  redirect(
    `/referrals?toast=referral-settled&toast_arg=${encodeURIComponent(
      `applied:${summary.applied} skipped:${summary.skipped} errors:${summary.errors}`
    )}`
  );
}
