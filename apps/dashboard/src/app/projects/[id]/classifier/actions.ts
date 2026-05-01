"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { sql, getProjectForUser } from "@/lib/db";
import { logAuditEvent } from "@/lib/audit";
import { planAllows } from "@/lib/plans";

/**
 * Server actions for the per-project embedding-classifier page.
 *
 * Mirrors the shape of `projects/[id]/policy/actions.ts` 1:1 — same
 * authorization checks, same audit event shape, same toast-via-redirect
 * feedback. The two lanes are kept in separate action files so a
 * change in one domain (e.g. classifier-specific quality-floor opt-out)
 * doesn't force a diff to the routing-policy actions.
 *
 * Gate: `background_policy_training` entitlement (same as policy
 * actions). Pro+ gets full control; Free sees the buttons + gets an
 * upgrade-required toast on submit.
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

/**
 * Pause / resume embedding-classifier training for this project.
 *
 * Shares the `projects.learning_enabled` flag with the routing-policy
 * retrain — a single flag gates BOTH trainings by design. The cloud
 * cron runs both jobs serially in the same nightly window, so one
 * flag per project is the right granularity. If a future tenant wants
 * to pause ONLY classifier training while keeping routing retrain
 * active, the fix is a second boolean column (not reshaping this
 * action).
 */
export async function setClassifierLearningEnabledAction(
  formData: FormData
): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const enabled = String(formData.get("enabled") ?? "false") === "true";
  if (!projectId) return;

  const { session, project } = await requireOwnedProject(projectId);

  if (enabled && !planAllows(session.user.plan, "background_policy_training")) {
    redirect(
      `/projects/${projectId}/classifier?toast=upgrade_required_for_learning`
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
    event: enabled
      ? "embedding_classifier.learning_resumed"
      : "embedding_classifier.learning_paused",
    targetType: "project",
    targetId: project.id,
    metadata: { learning_enabled: enabled },
    ip,
    userAgent: ua,
  });

  revalidatePath(`/projects/${projectId}/classifier`);
  redirect(
    `/projects/${projectId}/classifier?toast=${enabled ? "learning_resumed" : "learning_paused"}`
  );
}

/**
 * Rollback to a previously-superseded classifier version. Mirrors
 * `rollbackPolicyAction` — atomic flip inside one transaction with
 * pg_notify fan-out to live gateway replicas.
 *
 * The rolled-back row is written as a NEW version (v+1) referencing
 * the target version's payload, source='rollback'. We never mutate
 * the historical row — that keeps the audit story clean ("v23 is the
 * rollback-to-v17 record").
 */
export async function rollbackClassifierAction(
  formData: FormData
): Promise<void> {
  const projectId = String(formData.get("project_id") ?? "");
  const versionRaw = String(formData.get("version") ?? "");
  const targetVersion = Number.parseInt(versionRaw, 10);
  if (!projectId || !Number.isFinite(targetVersion)) return;

  const { session, project } = await requireOwnedProject(projectId);

  if (!planAllows(session.user.plan, "background_policy_training")) {
    redirect(
      `/projects/${projectId}/classifier?toast=upgrade_required_for_learning`
    );
  }

  let promotedTo = 0;
  try {
    await sql.begin(async (tx) => {
      const lockRows = await tx<{ id: string }[]>`
        SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE
      `;
      if (lockRows.length === 0) {
        throw new Error("project not found");
      }

      // Verify the target version exists and is rollback-able. We
      // accept 'superseded' and 'active' (rollback-to-current is a
      // no-op but not an error — just costs one extra row). We
      // deliberately REJECT 'rejected' — an operator shouldn't
      // resurrect an artifact we already flagged below the quality
      // floor.
      const targetRows = await tx<
        {
          payload: unknown;
          sample_count: number;
          task_type_accuracy: number | null;
          complexity_accuracy: number | null;
        }[]
      >`
        SELECT payload, sample_count, task_type_accuracy, complexity_accuracy
        FROM project_embedding_classifiers
        WHERE project_id = ${projectId}
          AND version = ${targetVersion}
          AND status IN ('superseded', 'active')
        LIMIT 1
      `;
      const target = targetRows[0];
      if (!target) {
        throw new Error(
          `version ${targetVersion} not eligible for rollback (must be superseded or active, and not rejected)`
        );
      }

      const nextRows = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM project_embedding_classifiers
        WHERE project_id = ${projectId}
      `;
      const nextVersion = nextRows[0]?.next_version ?? targetVersion + 1;
      promotedTo = nextVersion;

      await tx`
        INSERT INTO project_embedding_classifiers (
          project_id, version, status, payload, source, sample_count,
          task_type_accuracy, complexity_accuracy, notes
        ) VALUES (
          ${projectId},
          ${nextVersion},
          'pending',
          ${tx.json(target.payload as Parameters<typeof tx.json>[0])},
          'rollback',
          ${target.sample_count},
          ${target.task_type_accuracy},
          ${target.complexity_accuracy},
          ${`Rolled back to v${targetVersion} by ${session.user.email ?? session.user.id}`}
        )
      `;
      await tx`
        UPDATE project_embedding_classifiers
        SET status = 'superseded'
        WHERE project_id = ${projectId}
          AND status = 'active'
      `;
      await tx`
        UPDATE project_embedding_classifiers
        SET status = 'active', activated_at = NOW()
        WHERE project_id = ${projectId}
          AND version = ${nextVersion}
      `;

      await tx`SELECT pg_notify('tokensmart_embedding_reload', ${JSON.stringify({ project_id: projectId, version: nextVersion })})`;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redirect(
      `/projects/${projectId}/classifier?toast=rollback_failed&detail=${encodeURIComponent(msg)}`
    );
  }

  const { ip, ua } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId: project.id,
    event: "embedding_classifier.rollback",
    targetType: "project_embedding_classifier",
    targetId: String(promotedTo),
    metadata: {
      rolled_back_to_version: targetVersion,
      promoted_as_version: promotedTo,
    },
    ip,
    userAgent: ua,
  });

  revalidatePath(`/projects/${projectId}/classifier`);
  redirect(
    `/projects/${projectId}/classifier?toast=rollback_complete&to=${targetVersion}&new=${promotedTo}`
  );
}
