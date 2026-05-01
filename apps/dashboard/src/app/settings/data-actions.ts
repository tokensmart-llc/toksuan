"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import { sql } from "@/lib/db";

async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
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
 * Mark the current user's account for deletion. Sets `users.deleted_at`
 * to NOW(); the `sweep-deleted-users` cron hard-deletes rows older
 * than 30 days (matches the DPA §7.2 commitment). During the grace
 * window the user can still log in — they'll see a banner and the
 * Cancel button below.
 *
 * Confirmation: the form must POST `confirm=DELETE` (exact string,
 * case-sensitive) to prevent one-click accidents. Same pattern we
 * use for organization-ownership transfer.
 *
 * What's NOT touched here: Stripe subscriptions (user must cancel
 * themselves via the customer portal) and org ownership (a user who
 * owns an org can't delete their account until they've transferred
 * ownership — the DB helper enforces this). Silent attempts to
 * orphan an org get redirected to an actionable toast.
 */
export async function markAccountForDeletionAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const confirm = String(formData.get("confirm") ?? "");
  if (confirm !== "DELETE") {
    redirect("/settings?toast=account-delete-confirm-mismatch");
  }

  // Block users who still own an org with other members. They'd
  // orphan the org on hard-delete; make them transfer ownership first.
  const orgsOwned = await sql<{ id: string; name: string; member_count: number }[]>`
    SELECT o.id, o.name,
           (SELECT COUNT(*)::int FROM organization_members
             WHERE organization_id = o.id) AS member_count
      FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
     WHERE m.user_id = ${session.user.id} AND m.role = 'owner'
  `;
  const blocking = orgsOwned.filter((o) => o.member_count > 1);
  if (blocking.length > 0) {
    redirect(
      `/settings?toast=account-delete-org-owner&toast_arg=${encodeURIComponent(blocking[0].name)}`
    );
  }

  await sql`
    UPDATE users SET deleted_at = NOW() WHERE id = ${session.user.id}
  `;

  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "account.deletion_requested",
    targetType: "user",
    targetId: session.user.id,
    metadata: { grace_period_days: 30 },
    ip: await actorIp(),
  });

  redirect("/settings?toast=account-delete-scheduled");
}

/**
 * Cancel a pending deletion — sets `deleted_at` back to NULL. Safe
 * to call even when `deleted_at` is already NULL (no-op). The user
 * must still be able to log in to click this button, which means the
 * cron hasn't hard-deleted them yet; that's the grace window by
 * design.
 */
export async function cancelAccountDeletionAction(): Promise<void> {
  const session = await requireSession();
  await sql`
    UPDATE users SET deleted_at = NULL WHERE id = ${session.user.id}
  `;
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "account.deletion_cancelled",
    targetType: "user",
    targetId: session.user.id,
    ip: await actorIp(),
  });
  redirect("/settings?toast=account-delete-cancelled");
}
