"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { sql, getProjectForUser } from "@/lib/db";
import { logAuditEvent } from "@/lib/audit";
import { planAllows } from "@/lib/plans";

/**
 * Server actions for the per-project policy page.
 *
 * Two operations live here:
 *
 *   1. setLearningEnabledAction — pause/resume background training
 *      for this project. Flips `projects.learning_enabled`. The
 *      Stripe webhook flips it on subscription state changes; this
 *      action lets a paid user override that for any reason
 *      ("we're freezing routing during the holiday code freeze").
 *
 *   2. rollbackPolicyAction — promote a previously-superseded
 *      version back to active. Used when last night's retrain
 *      regressed real-world savings and the operator wants the
 *      previous policy back without waiting for the next cron run.
 *
 * Both require Pro+ entitlement (background_policy_training). Free
 * users see the controls but get a 403 toast on submit. We don't
 * hide the UI entirely so they can see what they'd be unlocking.
 */

async function requireOwnedProject(projectId: string) {
  const session = await getSession();
  if (!session) redirect("/login");
  const project = await getProjectForUser(session.user.id, projectId);
  if (!project) redirect("/projects");
  return { session, project };
}

async function actorContext() {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null;
  const ua = h.get("user-agent") ?? null;
  return { ip, ua };
}

export async function setLearningEnabledAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const enabled = String(formData.get("enabled") ?? "false") === "true";
  if (!projectId) return;

  const { session, project } = await requireOwnedProject(projectId);

  // Free users can VIEW the toggle but flipping it on requires Pro+.
  // Letting them flip it OFF is fine — pausing your own learning is
  // never billed-feature-gated.
  if (enabled && !planAllows(session.user.plan, "background_policy_training")) {
    redirect(
      `/projects/${projectId}/policy?toast=upgrade_required_for_learning`
    );
  }

  await sql`
    UPDATE projects SET learning_enabled = ${enabled}
    WHERE id = ${projectId} AND user_id = ${session.user.id}
  `;

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: enabled ? "policy.learning_resumed" : "policy.learning_paused",
    targetType: "project",
    targetId: project.id,
    metadata: { learning_enabled: enabled },
    ip,
    userAgent: ua,
  });

  revalidatePath(`/projects/${projectId}/policy`);
  redirect(
    `/projects/${projectId}/policy?toast=${enabled ? "learning_resumed" : "learning_paused"}`
  );
}

export async function rollbackPolicyAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const versionRaw = String(formData.get("version") ?? "");
  const targetVersion = Number.parseInt(versionRaw, 10);
  if (!projectId || !Number.isFinite(targetVersion)) return;

  const { session, project } = await requireOwnedProject(projectId);

  // Rollback is part of the paid feature surface (the audit story
  // and the operational guarantee — "you can always go back to v17"
  // — is the whole pitch of versioned policies).
  if (!planAllows(session.user.plan, "background_policy_training")) {
    redirect(
      `/projects/${projectId}/policy?toast=upgrade_required_for_learning`
    );
  }

  // Atomic flip: demote the current active row, promote the target,
  // record the rollback as a fresh row WITH source='rollback' so the
  // changelog shows it as a deliberate operator action (NOT a new
  // training run). All in one transaction so the gateway never sees
  // a window with two active rows.
  let promotedTo = 0;
  try {
    await sql.begin(async (tx) => {
      const lockRows = await tx<{ id: string }[]>`
        SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE
      `;
      if (lockRows.length === 0) {
        throw new Error("project not found");
      }

      // Verify the target version exists and is rollback-able.
      const targetRows = await tx<
        { payload: unknown; sample_count: number; tag: string | null }[]
      >`
        SELECT payload, sample_count, tag
        FROM project_policies
        WHERE project_id = ${projectId}
          AND version = ${targetVersion}
          AND status IN ('superseded', 'active', 'pending')
        LIMIT 1
      `;
      const target = targetRows[0];
      if (!target) {
        throw new Error(`version ${targetVersion} not eligible for rollback`);
      }

      // Find the next version number for this (project, tag) lane.
      const nextRows = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM project_policies
        WHERE project_id = ${projectId}
          AND tag IS NOT DISTINCT FROM ${target.tag}
      `;
      const nextVersion = nextRows[0]?.next_version ?? targetVersion + 1;
      promotedTo = nextVersion;

      // Insert a new row that's a duplicate of the target's payload,
      // so the changelog explicitly shows "v23 was rollback to v17"
      // instead of mutating v17's status (which would lose history).
      await tx`
        INSERT INTO project_policies (
          project_id, tag, version, status, payload, source, sample_count, notes
        ) VALUES (
          ${projectId},
          ${target.tag},
          ${nextVersion},
          'pending',
          ${tx.json(target.payload as Parameters<typeof tx.json>[0])},
          'rollback',
          ${target.sample_count},
          ${`Rolled back to v${targetVersion} by ${session.user.email ?? session.user.id}`}
        )
      `;
      await tx`
        UPDATE project_policies
        SET status = 'superseded'
        WHERE project_id = ${projectId}
          AND tag IS NOT DISTINCT FROM ${target.tag}
          AND status = 'active'
      `;
      await tx`
        UPDATE project_policies
        SET status = 'active', activated_at = NOW()
        WHERE project_id = ${projectId}
          AND tag IS NOT DISTINCT FROM ${target.tag}
          AND version = ${nextVersion}
      `;

      // Cross-process notify so other gateway replicas drop their
      // cache without waiting for TTL. Best-effort.
      const tagPayload = target.tag;
      await tx`SELECT pg_notify('tokensmart_policy_invalidate', ${JSON.stringify({ project_id: projectId, tag: tagPayload })})`;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redirect(
      `/projects/${projectId}/policy?toast=rollback_failed&detail=${encodeURIComponent(msg)}`
    );
  }

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: "policy.rollback",
    targetType: "project_policy",
    targetId: String(promotedTo),
    metadata: {
      rolled_back_to_version: targetVersion,
      promoted_as_version: promotedTo,
    },
    ip,
    userAgent: ua,
  });

  revalidatePath(`/projects/${projectId}/policy`);
  redirect(
    `/projects/${projectId}/policy?toast=rollback_complete&to=${targetVersion}&new=${promotedTo}`
  );
}
