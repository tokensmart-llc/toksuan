#!/usr/bin/env bun
/**
 * Hard-delete user rows past the 30-day grace window from the C1
 * follow-up (migration 015 + `/settings` "Delete my account" flow).
 *
 * Design:
 *   - Users with `deleted_at < NOW() - 30 days` are the targets.
 *   - Per-user we do the cascade by hand inside a TX so foreign-key
 *     ordering is explicit:
 *       1. DELETE requests (personal projects) + ab_results
 *       2. DELETE api_keys (personal projects)
 *       3. DELETE budgets / routing_rules / alert_rules / prompt_templates
 *       4. DELETE audit_events (REFERENCES users ON DELETE SET NULL, so
 *          we null them rather than delete — 3-yr SOC-2 retention)
 *       5. DELETE projects owned personally (not org-shared)
 *       6. DELETE organization_members
 *       7. DELETE organizations OWNED personally and with zero other members
 *          — if any other member exists the safety check at account-marking
 *          time already blocked the request; defense in depth here
 *       8. DELETE user_provider_keys
 *       9. DELETE sessions + magic_links keyed to this user
 *       10. DELETE from users
 *
 *   - Written as a single transaction per user so a half-applied
 *     delete is impossible. Errors on one user don't block the rest.
 *
 *   - Audit side: a `user.hard_deleted` row lands in `ops_audit_events`
 *     (user_id NULL because we can't reference a row we're deleting;
 *     target_id carries the now-gone user UUID for forensics). The
 *     per-user `audit_events` are kept at NULL-user for the 3-yr
 *     window the DPA promises.
 *
 * Schedule:
 *   - GitHub Actions cron daily at 05:00 UTC (after the 04:30 UTC
 *     referral settle pass).
 *   - Safe to run more often — idempotent (zero rows match if nothing
 *     has aged past 30d yet).
 *
 * Exit codes:
 *   0  completed (any per-user error is logged, script exits 0 so the
 *      cron doesn't alert on a single retryable user)
 *   1  fatal: DB unreachable
 */

import { sql } from "../src/lib/db";

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log("[sweep-deleted-users] starting");

  const due = await sql<{ id: string; email: string }[]>`
    SELECT id, email FROM users
     WHERE deleted_at IS NOT NULL
       AND deleted_at < NOW() - INTERVAL '30 days'
     ORDER BY deleted_at ASC
  `;

  let deleted = 0;
  let errors = 0;
  for (const u of due) {
    try {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM ab_results WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${u.id})`;
        await tx`DELETE FROM requests   WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${u.id})`;
        await tx`DELETE FROM api_keys   WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${u.id})`;
        await tx`DELETE FROM budgets    WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${u.id})`;
        await tx`DELETE FROM routing_rules WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${u.id})`;
        await tx`DELETE FROM alert_rules   WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${u.id})`;
        await tx`DELETE FROM prompt_templates WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${u.id})`;

        // Audit events: null the user_id instead of deleting so the
        // 3-yr SOC-2 retention window still holds. `users` FK is
        // `ON DELETE SET NULL` in the schema but some older deploys
        // lack that — doing it explicitly avoids surprises.
        await tx`UPDATE audit_events SET user_id = NULL, actor_email = NULL WHERE user_id = ${u.id}`;

        // Personal projects with no org — safe to delete. Org-shared
        // projects (`organization_id IS NOT NULL`) stay; they belong
        // to the org regardless of who originally created them.
        await tx`DELETE FROM projects WHERE user_id = ${u.id} AND organization_id IS NULL`;
        // For projects that have BOTH user_id and organization_id set,
        // null the user_id so the project stays accessible via org
        // membership.
        await tx`UPDATE projects SET user_id = NULL WHERE user_id = ${u.id}`;

        await tx`DELETE FROM organization_members WHERE user_id = ${u.id}`;

        // Orgs owned by this user with ZERO remaining members get
        // deleted. The markAccountForDeletionAction blocks users who
        // own orgs with >1 member; this is the defense-in-depth safety
        // net. Because organization_members was just cleared above,
        // any remaining members are other users, and the org stays.
        await tx`DELETE FROM organizations
                  WHERE created_by_user_id = ${u.id}
                    AND NOT EXISTS (
                      SELECT 1 FROM organization_members
                       WHERE organization_id = organizations.id
                    )`;
        // For orgs this user owned but that have other members, null
        // the created_by_user_id reference.
        await tx`UPDATE organizations SET created_by_user_id = NULL WHERE created_by_user_id = ${u.id}`;

        await tx`DELETE FROM user_provider_keys WHERE user_id = ${u.id}`;
        await tx`DELETE FROM sessions WHERE user_id = ${u.id}`;
        await tx`DELETE FROM magic_links WHERE email = ${u.email}`;
        await tx`DELETE FROM users WHERE id = ${u.id}`;

        await tx`
          INSERT INTO ops_audit_events (
            user_id, event, target_type, target_id, actor, metadata, ip
          ) VALUES (
            NULL,
            ${"user.hard_deleted"},
            ${"user"},
            ${u.id},
            ${"cron"},
            ${tx.json({ reason: "30d_grace_elapsed" } as Parameters<typeof tx.json>[0])},
            NULL
          )
        `;
      });
      deleted++;
      console.log(`[sweep-deleted-users] hard-deleted user ${u.id}`);
    } catch (err) {
      errors++;
      console.error(
        `[sweep-deleted-users] failed to delete ${u.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[sweep-deleted-users] done — deleted=${deleted} errors=${errors} elapsed=${elapsedMs}ms`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[sweep-deleted-users] fatal:", err);
  process.exit(1);
});
