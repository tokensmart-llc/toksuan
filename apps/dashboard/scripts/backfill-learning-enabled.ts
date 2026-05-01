#!/usr/bin/env bun
/**
 * One-shot backfill of `projects.learning_enabled` for paid users.
 *
 * Migration 019 added `learning_enabled` and defaulted it to FALSE
 * for every project. The Stripe webhook (`syncProjectLearningFlag`)
 * keeps NEW subscription state changes in sync — but customers who
 * were already on a paid plan when 019 deployed have learning OFF
 * until their NEXT subscription event fires (could be weeks).
 *
 * That's a real product bug for them: they're paying for the
 * background-trained policy feature but not getting it. This script
 * closes the gap by walking every user with plan IN ('pro','team',
 * 'scale') and flipping `learning_enabled = TRUE` on every project
 * they own. Idempotent — re-running on a freshly-synced DB is a
 * no-op (the WHERE clause skips rows already in the right state).
 *
 * Designed for:
 *   - One-off operator run after a 019 deploy (`bun run backfill-learning-enabled`)
 *   - Safe to schedule daily as an "eventual consistency" guard for
 *     subscriptions that change while the webhook is degraded
 *
 * Usage:
 *   bun run backfill-learning-enabled                  # apply
 *   bun run backfill-learning-enabled -- --dry-run     # count, don't write
 *   bun run backfill-learning-enabled -- --user <uuid> # one user only
 *
 * Exit codes:
 *   0  ok (rows flipped or 0 rows in scope)
 *   1  fatal error
 */

import { sql } from "../src/lib/db";

type Args = {
  dryRun: boolean;
  userId: string | null;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, userId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--user":
        a.userId = next ?? null;
        i++;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg && arg.startsWith("--")) {
          console.error(`backfill-learning-enabled: unknown flag: ${arg}`);
          process.exit(1);
        }
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`Usage:
  bun run backfill-learning-enabled                   # apply to every paid user
  bun run backfill-learning-enabled -- --dry-run      # count, don't write
  bun run backfill-learning-enabled -- --user <uuid>  # one user only (apply)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const userScope = args.userId ? `user=${args.userId}` : "all paid users";
  const mode = args.dryRun ? "DRY-RUN" : "APPLY";
  console.log(`[backfill-learning-enabled] mode=${mode} scope=${userScope}`);

  // Stage 1: figure out who's in scope. We compute the count + list
  // of (user_id, project_id) pairs that WOULD flip, so dry-run prints
  // a useful preview and apply prints the same set after writing.
  const scopeRows = await sql<
    { user_id: string; user_email: string | null; user_plan: string; project_id: string; project_name: string }[]
  >`
    SELECT u.id AS user_id, u.email AS user_email, u.plan AS user_plan,
           p.id AS project_id, p.name AS project_name
    FROM projects p
    JOIN users u ON u.id = p.user_id
    WHERE u.plan IN ('pro', 'team', 'scale')
      AND p.learning_enabled = FALSE
      ${args.userId ? sql`AND u.id = ${args.userId}` : sql``}
    ORDER BY u.email NULLS LAST, p.created_at ASC
  `;

  if (scopeRows.length === 0) {
    console.log(
      `[backfill-learning-enabled] no projects need flipping (every paid user's projects already have learning_enabled=TRUE).`
    );
    process.exit(0);
  }

  // Group for legibility — operators care more about "5 projects across
  // 3 users" than "5 individual rows". Print the user-level summary,
  // then the per-project lines under each.
  const byUser = new Map<
    string,
    { email: string | null; plan: string; projects: { id: string; name: string }[] }
  >();
  for (const r of scopeRows) {
    let bucket = byUser.get(r.user_id);
    if (!bucket) {
      bucket = { email: r.user_email, plan: r.user_plan, projects: [] };
      byUser.set(r.user_id, bucket);
    }
    bucket.projects.push({ id: r.project_id, name: r.project_name });
  }

  console.log(
    `[backfill-learning-enabled] would flip ${scopeRows.length} project(s) across ${byUser.size} user(s):`
  );
  for (const [uid, info] of byUser) {
    console.log(
      `  ${info.email ?? uid.slice(0, 8)} (${info.plan}, ${info.projects.length} project${info.projects.length === 1 ? "" : "s"})`
    );
    for (const p of info.projects) {
      console.log(`    • ${p.name} (${p.id.slice(0, 8)}…)`);
    }
  }

  if (args.dryRun) {
    console.log(`\n[backfill-learning-enabled] --dry-run: not writing.`);
    process.exit(0);
  }

  // Stage 2: apply. Single UPDATE, gated by the same predicate so a
  // race (Stripe webhook flipping a row to TRUE between our SELECT
  // and our UPDATE) doesn't accidentally overwrite anything. RETURNING
  // gives us the exact count we updated, which we cross-check against
  // the scope count.
  const updated = await sql<{ id: string }[]>`
    UPDATE projects
       SET learning_enabled = TRUE
     WHERE user_id IN (SELECT id FROM users WHERE plan IN ('pro', 'team', 'scale'))
       AND learning_enabled = FALSE
       ${args.userId ? sql`AND user_id = ${args.userId}` : sql``}
    RETURNING id
  `;

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `\n[backfill-learning-enabled] done — flipped ${updated.length}/${scopeRows.length} project(s) (elapsed=${elapsedMs}ms)`
  );

  // Best-effort audit row. Same pattern as sweep-expired-api-keys.ts —
  // operators want to confirm the script actually ran, even on a
  // 0-rows day.
  try {
    await sql`
      INSERT INTO ops_audit_events (
        user_id, event, target_type, target_id, actor, metadata, ip
      ) VALUES (
        NULL,
        ${"policy.learning_enabled_backfill"},
        ${"projects"},
        NULL,
        ${"cron"},
        ${sql.json({
          flipped: updated.length,
          elapsed_ms: elapsedMs,
          scoped_user: args.userId,
          dry_run: false,
        } as Parameters<typeof sql.json>[0])},
        NULL
      )
    `;
  } catch (err) {
    console.warn(
      "[backfill-learning-enabled] ops_audit_events insert failed:",
      err instanceof Error ? err.message : err
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-learning-enabled] fatal:", err);
  process.exit(1);
});
