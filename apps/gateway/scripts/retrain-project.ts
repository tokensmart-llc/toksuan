#!/usr/bin/env bun
/**
 * Retrain a single project's routing policy.
 *
 * Pipeline:
 *
 *   1. Read up to N days of `ab_results` for the project.
 *   2. Bayesian-merge with the shipped baseline policy (per-cell
 *      weighted average — see `src/policy/aggregator.ts`).
 *   3. Run a sanity check (no bucket collapsed, observation count
 *      sufficient).
 *   4. Insert a new `project_policies` row with status='pending'.
 *   5. Promote: flip 'pending' → 'active', demote previous 'active'
 *      to 'superseded'. All in one transaction so the gateway never
 *      sees a half-applied switch.
 *   6. Invalidate the local in-process cache so the next request
 *      from this process picks up the new policy without waiting
 *      for the 60s TTL.
 *
 * What the cloud cron does on top of this:
 *   - Forks one job per paid-tier project, parallelism-capped
 *   - Captures stdout/stderr per job for the dashboard log card
 *   - On failure: pages the on-call, leaves the previous active row in place
 *
 * Self-host operators run this script directly, on whatever schedule
 * makes sense for their workload (cron / launchd / systemd timer).
 *
 * Examples:
 *   # Dry run — print what would happen, don't write
 *   bun run retrain-project -- --project <uuid> --dry-run
 *
 *   # Actually retrain + activate
 *   bun run retrain-project -- --project <uuid>
 *
 *   # Retrain ALL projects with learning_enabled=TRUE (cloud cron mode)
 *   bun run retrain-project -- --all-enabled
 *
 *   # Tune the look-back window or prior strength (defaults: 7d, 20)
 *   bun run retrain-project -- --project <uuid> --lookback-days 14 --prior 30
 */

import { sql } from "../src/db";
import {
  aggregateProjectPolicy,
  type AggregateResult,
} from "../src/policy/aggregator";
import { invalidateProjectPolicy } from "../src/policy/loader";
import { dispatchAlert } from "../src/alerts";

type Args = {
  project: string | null;
  allEnabled: boolean;
  dryRun: boolean;
  lookbackDays: number;
  priorStrength: number;
  source: "manual" | "retrain";
  notes: string | null;
  /**
   * Specific x-ts-tag to train against. NULL = the project-default
   * policy (mixes every request regardless of tag). Passing --tag
   * trains only the tag-specific policy and stores it under
   * (project_id, tag) in project_policies.
   */
  tag: string | null;
  /**
   * "all": when --all-enabled is also set, retrain BOTH the project
   * default policy AND every distinct tag observed in the project's
   * recent shadow rows. Default: 'default-only' (just the project
   * default — fastest, easiest to reason about).
   */
  tagsScope: "default-only" | "all-observed";
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    project: null,
    allEnabled: false,
    dryRun: false,
    lookbackDays: 7,
    priorStrength: 20,
    source: "manual",
    notes: null,
    tag: null,
    tagsScope: "default-only",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--project":
        a.project = next ?? null;
        i++;
        break;
      case "--all-enabled":
        a.allEnabled = true;
        a.source = "retrain";
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--lookback-days": {
        const n = Number(next);
        if (!Number.isFinite(n) || n < 1) {
          fail(`--lookback-days must be a positive integer (got ${next})`);
        }
        a.lookbackDays = n;
        i++;
        break;
      }
      case "--prior": {
        const n = Number(next);
        if (!Number.isFinite(n) || n < 0) {
          fail(`--prior must be a non-negative number (got ${next})`);
        }
        a.priorStrength = n;
        i++;
        break;
      }
      case "--notes":
        a.notes = next ?? null;
        i++;
        break;
      case "--source":
        if (next !== "manual" && next !== "retrain") {
          fail(`--source must be 'manual' or 'retrain' (got ${next})`);
        }
        a.source = next;
        i++;
        break;
      case "--tag":
        a.tag = next ?? null;
        i++;
        break;
      case "--tags-scope":
        if (next !== "default-only" && next !== "all-observed") {
          fail(
            `--tags-scope must be 'default-only' or 'all-observed' (got ${next})`
          );
        }
        a.tagsScope = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg && arg.startsWith("--")) {
          fail(`unknown flag: ${arg}`);
        }
    }
  }

  if (!a.project && !a.allEnabled) {
    fail("must pass --project <uuid> OR --all-enabled");
  }
  return a;
}

function printHelp(): void {
  console.log(`Usage:
  bun run retrain-project -- --project <uuid> [--dry-run] [--lookback-days 7] [--prior 20] [--tag <tag>]
  bun run retrain-project -- --all-enabled [--dry-run] [--lookback-days 7] [--tags-scope default-only|all-observed]

--project       Single project UUID to retrain.
--all-enabled   Retrain every project where projects.learning_enabled = TRUE.
                Cloud cron mode. Skipped projects are logged but not fatal.
--dry-run       Aggregate + print summary, but DO NOT write project_policies.
--lookback-days How far back to read ab_results. Default: 7. Cap: 90.
--prior         Equivalent-sample-count of the baseline. Higher = trust the
                shipped policy more. Default: 20.
--notes         Free-text rationale stored on the policy row.
--source        'manual' (default for --project) or 'retrain' (default for
                --all-enabled). Just metadata for the changelog UI.
--tag           Train only a tag-specific policy. Pairs with the request's
                x-ts-tag header at routing time. Skip to train the project
                default (mixes every request).
--tags-scope    With --all-enabled only:
                  default-only (default) — train just each project's default
                                           policy
                  all-observed         — train default policy AND every
                                         distinct tag observed in the
                                         project's recent shadow rows
`);
}

function fail(msg: string): never {
  console.error(`retrain-project: ${msg}\n`);
  printHelp();
  process.exit(1);
}

/**
 * Sanity check the freshly-aggregated policy before promotion.
 * Returns null on pass, an error string on fail. The whole point is
 * to refuse to promote a policy that would obviously break routing.
 */
function sanityCheck(result: AggregateResult): string | null {
  if (result.policy.buckets.length === 0) {
    return "policy has zero buckets";
  }
  // Every bucket must end up with at least one model — an empty
  // bucket means the gateway will pass through without a downgrade
  // suggestion, which technically works, but it almost always
  // indicates a bad merge (Pareto-filtered everything away).
  const empty = result.policy.buckets.filter((b) => b.models.length === 0);
  if (empty.length > 0) {
    return `${empty.length} bucket(s) emptied by Pareto filter: ${empty
      .map((b) => `${b.task_type}/${b.complexity}`)
      .join(", ")}`;
  }
  // If we ended up with zero observations AND zero changes vs prior,
  // there's nothing to promote — caller can decide if that's an
  // error or a no-op.
  if (result.sample_count === 0 && result.bucket_changes.length === 0) {
    return "no new observations and no bucket changes — nothing to promote";
  }
  return null;
}

async function retrainOne(
  projectId: string,
  args: Args,
  tag: string | null
): Promise<{ ok: boolean; version: number | null; reason: string }> {
  const tagLabel = tag ? `tag=${tag}` : "tag=<default>";
  console.log(`\n[retrain] project=${projectId} ${tagLabel}`);

  let result: AggregateResult;
  try {
    result = await aggregateProjectPolicy(projectId, {
      lookbackDays: args.lookbackDays,
      priorStrength: args.priorStrength,
      tag,
    });
  } catch (err) {
    return {
      ok: false,
      version: null,
      reason: `aggregate failed: ${(err as Error).message}`,
    };
  }

  console.log(
    `[retrain]   samples_considered=${result.sample_count} bucket_changes=${result.bucket_changes.length}`
  );
  for (const ch of result.bucket_changes) {
    console.log(`[retrain]   • ${ch.note}`);
  }

  const sanity = sanityCheck(result);
  if (sanity) {
    return { ok: false, version: null, reason: sanity };
  }

  if (args.dryRun) {
    console.log("[retrain]   --dry-run: not writing.");
    return { ok: true, version: null, reason: "dry_run" };
  }

  // Single transaction:
  //   - SELECT MAX(version) for the (project, tag) tuple
  //     (FOR UPDATE on the project row, in case a concurrent
  //     retrain races us).
  //   - INSERT new row with status='pending'.
  //   - UPDATE prior 'active' for the same (project, tag) → 'superseded'.
  //   - UPDATE new row → 'active' + activated_at = NOW().
  // Per-tag retrains never collide with default retrains: the
  // (project_id, tag, version) unique index treats them as
  // independent series. NULL tag = the project default lane.
  // Either everything happens or nothing does — gateway never sees a
  // half-state because reads of `status='active'` are point-in-time.
  let promotedVersion = 0;
  try {
    await sql.begin(async (tx) => {
      const lockRows = await tx<{ id: string }[]>`
        SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE
      `;
      if (lockRows.length === 0) {
        throw new Error(`project ${projectId} not found`);
      }
      // Version is per (project, tag) tuple — NULL tag has its own series.
      const versionRow = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM project_policies
        WHERE project_id = ${projectId}
          AND tag IS NOT DISTINCT FROM ${tag}
      `;
      const nextVersion = versionRow[0]?.next_version ?? 1;
      promotedVersion = nextVersion;

      await tx`
        INSERT INTO project_policies (
          project_id, tag, version, status, payload, source, sample_count, notes
        ) VALUES (
          ${projectId},
          ${tag},
          ${nextVersion},
          'pending',
          ${tx.json(result.policy as unknown as Parameters<typeof tx.json>[0])},
          ${args.source},
          ${result.sample_count},
          ${args.notes ?? renderDefaultNotes(result)}
        )
      `;
      await tx`
        UPDATE project_policies
        SET status = 'superseded'
        WHERE project_id = ${projectId}
          AND tag IS NOT DISTINCT FROM ${tag}
          AND status = 'active'
      `;
      await tx`
        UPDATE project_policies
        SET status = 'active', activated_at = NOW()
        WHERE project_id = ${projectId}
          AND tag IS NOT DISTINCT FROM ${tag}
          AND version = ${nextVersion}
      `;
    });
  } catch (err) {
    return {
      ok: false,
      version: null,
      reason: `transaction failed: ${(err as Error).message}`,
    };
  }

  // Targeted invalidation: only the (project, tag) cache entry
  // affected by this retrain. Other tag policies for the same
  // project keep serving from their cached entries.
  invalidateProjectPolicy(projectId, tag);
  // Best-effort cross-process notify (LISTEN/NOTIFY hookup in a
  // companion patch). Failures are non-fatal — TTL eventually
  // catches up.
  notifyPolicyChanged(projectId, tag).catch((e) =>
    console.warn(
      `[retrain]   NOTIFY failed (non-fatal): ${(e as Error).message}`
    )
  );
  console.log(`[retrain]   promoted v${promotedVersion} (status=active)`);
  return { ok: true, version: promotedVersion, reason: "promoted" };
}

/**
 * Send a Postgres NOTIFY so multi-replica gateways can drop their
 * cached entry for this (project_id, tag) immediately, instead of
 * waiting out the 60s loader TTL. Listening side lives in
 * `policy/loader.ts`. The payload is a tiny JSON blob, well under
 * the 8KB NOTIFY payload cap.
 */
async function notifyPolicyChanged(
  projectId: string,
  tag: string | null
): Promise<void> {
  const payload = JSON.stringify({ project_id: projectId, tag });
  await sql`SELECT pg_notify('tokensmart_policy_invalidate', ${payload})`;
}

/**
 * Discover every distinct x-ts-tag value that appeared on this
 * project's `requests` rows over the lookback window. Used by
 * --tags-scope=all-observed so the cron picks up new workloads
 * automatically without manual --tag invocations.
 */
async function listObservedTagsForProject(
  projectId: string,
  lookbackDays: number
): Promise<string[]> {
  const days = Math.max(1, Math.min(lookbackDays, 90));
  const rows = await sql<{ tag: string }[]>`
    SELECT DISTINCT (jsonb_object_keys(tags)) AS tag
    FROM requests
    WHERE project_id = ${projectId}
      AND created_at > NOW() - (${days}::int || ' days')::interval
      AND tags <> '{}'::jsonb
  `;
  return rows.map((r) => r.tag);
}

function renderDefaultNotes(result: AggregateResult): string {
  if (result.bucket_changes.length === 0) {
    return `Retrained from ${result.sample_count} samples; no bucket winner changed.`;
  }
  const top = result.bucket_changes
    .slice(0, 5)
    .map((c) => c.note)
    .join("; ");
  const overflow =
    result.bucket_changes.length > 5
      ? ` (+${result.bucket_changes.length - 5} more)`
      : "";
  return `Retrained from ${result.sample_count} samples. ${top}${overflow}`;
}

async function listEnabledProjects(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM projects WHERE learning_enabled = TRUE
  `;
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let projects: string[];
  if (args.allEnabled) {
    projects = await listEnabledProjects();
    if (projects.length === 0) {
      console.log("[retrain] no projects with learning_enabled = TRUE.");
      return;
    }
    console.log(
      `[retrain] ${projects.length} project(s) with learning enabled.`
    );
  } else {
    projects = [args.project!];
  }

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  for (const projectId of projects) {
    // Build the list of (project, tag) pairs to retrain for this project:
    //   1. Single --project run with --tag X     → exactly that tag
    //   2. Single --project run without --tag    → just the project default
    //   3. --all-enabled --tags-scope default-only → just the default per project
    //   4. --all-enabled --tags-scope all-observed → default + every distinct
    //      tag observed in this project's last `lookbackDays` of requests
    const tagsToTrain: (string | null)[] = [];
    if (args.tag !== null) {
      tagsToTrain.push(args.tag);
    } else {
      tagsToTrain.push(null); // project default
      if (args.allEnabled && args.tagsScope === "all-observed") {
        try {
          const observed = await listObservedTagsForProject(
            projectId,
            args.lookbackDays
          );
          for (const t of observed) tagsToTrain.push(t);
        } catch (e) {
          console.warn(
            `[retrain] failed to list observed tags for ${projectId}: ${(e as Error).message} — falling back to default-only`
          );
        }
      }
    }

    for (const tag of tagsToTrain) {
      const r = await retrainOne(projectId, args, tag);
      if (r.ok && r.version !== null) {
        okCount++;
      } else if (r.ok) {
        // Dry run that would have promoted.
        okCount++;
      } else {
        // "no observations" is a soft skip in --all-enabled mode (we
        // expect plenty of low-traffic projects); a hard fail otherwise.
        const isSkip = /no new observations/i.test(r.reason);
        if (args.allEnabled && isSkip) {
          console.log(`[retrain]   skipped: ${r.reason}`);
          skipCount++;
        } else {
          console.error(`[retrain]   FAILED: ${r.reason}`);
          failCount++;
          // Surface failures through the existing alert pipeline. The
          // project's owner gets whatever delivery channel they
          // subscribed to (webhook + / or email). Best-effort —
          // never crash the cron over an alert dispatch failure.
          // Suppressed for --dry-run so smoke tests don't spam alerts.
          if (!args.dryRun) {
            await dispatchAlert(projectId, "retrain_failed", {
              tag,
              reason: r.reason,
              source: args.source,
              lookback_days: args.lookbackDays,
              prior_strength: args.priorStrength,
            }).catch((e) =>
              console.warn(
                `[retrain]   alert dispatch failed (non-fatal): ${(e as Error).message}`
              )
            );
          }
        }
      }
    }
  }

  console.log(
    `\n[retrain] done: ${okCount} ok, ${skipCount} skipped, ${failCount} failed.`
  );
  if (failCount > 0) process.exit(2);
}

await main().catch((err) => {
  console.error(`retrain-project: unhandled error: ${err}`);
  process.exit(1);
});
