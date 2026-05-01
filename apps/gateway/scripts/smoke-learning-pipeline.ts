#!/usr/bin/env bun
/**
 * Full learning-pipeline smoke test.
 *
 * Exercises the complete background-policy training loop end-to-end
 * against a running gateway + Postgres, *without* needing Stripe or
 * Resend credentials. Each step asserts something concrete; the
 * script restores state on exit so it's safe to re-run.
 *
 * Stages (each prints PASS / FAIL):
 *
 *   1. Health: /health is reachable + reports semantic_cache + baseline
 *      policy state we expect.
 *   2. Schema sanity: migrations 019, 020, 021 are applied (column
 *      checks + the `pg_notify` channel exists).
 *   3. Seed: insert 12 ab_results rows on a known project so the
 *      aggregator has something to chew on. Tagged with a dedicated
 *      `smoke_run_id` so cleanup at the end is precise.
 *   4. Retrain: invoke `bun run retrain-project --project … --dry-run`
 *      (so we don't pollute project_policies with smoke versions),
 *      assert the CLI exits 0 and the bucket-change line landed.
 *   5. Promote (real this time): same CLI without --dry-run, assert a
 *      new project_policies row landed with status='active'.
 *   6. Loader: hit /v1/chat/completions with the seeded API key and
 *      assert the gateway log shows "[tokensmart] baseline routing"
 *      with our project's active policy version visible (proxy: a
 *      successful 200 + the response body model differs from the
 *      input model).
 *   7. NOTIFY: fire pg_notify('tokensmart_policy_invalidate', ...)
 *      and re-issue a chat call. We can't directly observe cache
 *      invalidation, but a 200 response with the correct routing is
 *      proof the loader didn't crash on the channel.
 *   8. Failure → alert dispatch: subscribe a smoke alert rule, force
 *      the retrain CLI to fail (use a tag with no observations),
 *      assert the alert was dispatched (look for the
 *      `[alerts] email →` log line in stdout).
 *   9. Cleanup: drop the seed ab_results, demote the smoke
 *      project_policies version, remove the smoke alert rule.
 *
 * Required env (defaults work against a local docker-compose stack):
 *   DATABASE_URL          (postgres://...)
 *   GATEWAY_URL           default http://localhost:8787
 *   API_KEY               default tokensmart-dev-key
 *   SMOKE_PROJECT_ID      default 00000000-0000-0000-0000-000000000001
 *
 * Modes:
 *   --ci     Skip the three network-bound stages (health, hot-path
 *            routed, NOTIFY-then-chat). Lets the smoke run in a CI
 *            environment that has Postgres + bun but no gateway
 *            HTTP server (and no provider credentials).
 *            Sub-15s typically.
 *
 * Exit codes:
 *   0  every stage passed (or was deliberately skipped)
 *   1  env/setup error
 *   2  one or more assertions failed
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import postgres from "postgres";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8787";
const API_KEY = process.env.API_KEY ?? "tokensmart-dev-key";
const PROJECT_ID =
  process.env.SMOKE_PROJECT_ID ?? "00000000-0000-0000-0000-000000000001";

// `--ci` turns off everything that needs the gateway HTTP server up.
// Keeps DB-only assertions on (schema, seed, retrain CLI, alert
// dispatch, cleanup) so the bulk of the regression coverage still
// runs in PR CI even without a live gateway + upstream credentials.
const CI_MODE = process.argv.includes("--ci");

const SMOKE_TAG = "smoke-pipeline";
const SMOKE_FINGERPRINT_PREFIX = `smoke-pipeline-${Date.now()}`;
const SMOKE_NOTES_NEEDLE = "smoke-pipeline-marker";

function log(...args: unknown[]): void {
  console.log("[smoke-pipeline]", ...args);
}
function pass(stage: string, detail: string): void {
  console.log(`  [PASS] ${stage}\n         ${detail}`);
}
function skip(stage: string, reason: string): void {
  console.log(`  [SKIP] ${stage}\n         ${reason}`);
}
function record(
  stage: string,
  ok: boolean,
  detail: string,
  fails: { count: number }
): void {
  if (ok) pass(stage, detail);
  else {
    console.log(`  [FAIL] ${stage}\n         ${detail}`);
    fails.count++;
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "[smoke-pipeline] DATABASE_URL is required. Source apps/gateway/.env first."
    );
    process.exit(1);
  }
  const sql = postgres(process.env.DATABASE_URL, {
    max: 2,
    idle_timeout: 10,
    onnotice: () => {},
  });
  const fails = { count: 0 };

  log(
    `gateway=${GATEWAY_URL} project=${PROJECT_ID}${CI_MODE ? " mode=CI" : ""}`
  );
  console.log("");

  // ---------- 1. Health -----------------------------------------------------
  if (CI_MODE) {
    skip("health", "CI mode — gateway HTTP server not assumed to be running");
  } else {
    try {
      const r = await fetch(`${GATEWAY_URL}/health`);
      const j = (await r.json()) as { ok?: boolean; integrations?: unknown };
      record(
        "health",
        r.ok && j.ok === true,
        `HTTP ${r.status} ok=${j.ok}`,
        fails
      );
    } catch (err) {
      record(
        "health",
        false,
        `fetch failed: ${(err as Error).message}`,
        fails
      );
    }
  }

  // ---------- 2. Schema sanity ---------------------------------------------
  // Asserts the columns introduced by 019/020/021 are present. Cheaper
  // than re-running migrations and a much clearer error if the test
  // is run against an out-of-date DB.
  try {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE (table_name = 'project_policies' AND column_name IN ('tag', 'version', 'status'))
         OR (table_name = 'routing_rules'    AND column_name = 'sample_rate')
         OR (table_name = 'projects'         AND column_name = 'learning_enabled')
    `;
    const present = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    const expected = [
      "project_policies.tag",
      "project_policies.version",
      "project_policies.status",
      "routing_rules.sample_rate",
      "projects.learning_enabled",
    ];
    const missing = expected.filter((e) => !present.has(e));
    record(
      "schema",
      missing.length === 0,
      missing.length === 0
        ? `${expected.length} expected columns found`
        : `missing: ${missing.join(", ")}`,
      fails
    );
  } catch (err) {
    record("schema", false, (err as Error).message, fails);
  }

  // Find a request_id we can anchor seed ab_results to. Without one,
  // the aggregator can't classify the bucket. If nothing exists (e.g.
  // a fresh CI Postgres), we synthesize one ourselves so this script
  // is self-contained — it should never need a human to "go run a
  // couple of curl calls first" before the smoke is meaningful.
  let anchorRequestId: string | null = null;
  let anchorWasSynthesized = false;
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM requests
      WHERE project_id = ${PROJECT_ID} AND status = 'success'
      ORDER BY created_at DESC LIMIT 1
    `;
    anchorRequestId = rows[0]?.id ?? null;
    if (!anchorRequestId) {
      // Synthesize. Bucket the aggregator infers from request_body
      // depends only on the messages — set a code-classified prompt
      // so the smoke ends up exercising the same cell as the local
      // dev path (code/medium → flash-lite). The key_id is nullable
      // on the table per migration 001, so we can leave it null.
      // Make sure the project actually exists first; on a fresh CI
      // DB it might not (migration 001 seeds the dev project but
      // a parallel test fixture might have torn it down).
      await sql`
        INSERT INTO projects (id, name, learning_enabled)
        VALUES (${PROJECT_ID}, 'smoke-pipeline-default', FALSE)
        ON CONFLICT (id) DO NOTHING
      `;
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO requests (
          project_id, provider, model,
          input_tokens, output_tokens, cost_micro_cents, latency_ms,
          status, fingerprint,
          request_body, response_body, tags
        ) VALUES (
          ${PROJECT_ID}, 'openai', 'gpt-4o-mini',
          50, 40, 100, 800,
          'success', ${SMOKE_FINGERPRINT_PREFIX + "-anchor"},
          ${sql.json({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content:
                  "Write a Python function `def dedupe(xs: list) -> list` that preserves order. Reply only with the function code.",
              },
            ],
          })},
          ${sql.json({})},
          ${sql.json({})}
        )
        RETURNING id
      `;
      anchorRequestId = inserted[0]?.id ?? null;
      anchorWasSynthesized = true;
    }
  } catch (err) {
    // non-fatal — the seed step below will record this as the actual fail
    log(`anchor lookup/synthesis failed: ${(err as Error).message}`);
  }

  // ---------- 3. Seed ab_results -------------------------------------------
  let seededRows = 0;
  try {
    if (!anchorRequestId) {
      throw new Error(
        "no successful requests in DB to anchor seed rows to. Make at least one /v1/chat/completions call against this project, then re-run."
      );
    }
    await sql`
      INSERT INTO ab_results (
        project_id, primary_request_id,
        primary_model, primary_provider,
        primary_input_tokens, primary_output_tokens, primary_cost_micro_cents, primary_latency_ms,
        shadow_model, shadow_provider,
        shadow_input_tokens, shadow_output_tokens, shadow_cost_micro_cents, shadow_latency_ms,
        shadow_status, similarity, fingerprint
      )
      SELECT
        ${PROJECT_ID}::uuid, ${anchorRequestId}::uuid,
        'gpt-5.2', 'openai',
        100, 80, 50000, 900,
        'gpt-4o-mini', 'openai',
        100, 80, 30, 600,
        'success', 0.92, ${SMOKE_FINGERPRINT_PREFIX} || '-' || g
      FROM generate_series(1, 12) g
    `;
    const cnt = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM ab_results
      WHERE fingerprint LIKE ${SMOKE_FINGERPRINT_PREFIX + "%"}
    `;
    seededRows = Number(cnt[0]?.n ?? 0);
    record(
      "seed ab_results",
      seededRows === 12,
      `inserted ${seededRows}/12 rows (anchor=${anchorRequestId.slice(0, 8)}${anchorWasSynthesized ? "/synth" : ""})`,
      fails
    );
  } catch (err) {
    record("seed ab_results", false, (err as Error).message, fails);
  }

  // ---------- 4. Retrain dry-run -------------------------------------------
  // Spawn the retrain CLI as a child process so we exercise the same
  // entrypoint a cron Job would.
  const retrainScript = path.resolve(
    new URL(".", import.meta.url).pathname,
    "retrain-project.ts"
  );
  const retrainDry = spawnSync(
    "bun",
    ["run", retrainScript, "--", "--project", PROJECT_ID, "--dry-run"],
    { encoding: "utf8" }
  );
  record(
    "retrain --dry-run",
    retrainDry.status === 0 &&
      retrainDry.stdout.includes("samples_considered="),
    `exit=${retrainDry.status}; stdout has ${
      retrainDry.stdout.includes("samples_considered=") ? "samples line" : "NO samples line"
    }`,
    fails
  );

  // ---------- 5. Retrain promote -------------------------------------------
  const retrainPromote = spawnSync(
    "bun",
    [
      "run",
      retrainScript,
      "--",
      "--project",
      PROJECT_ID,
      "--notes",
      `${SMOKE_NOTES_NEEDLE} from smoke-learning-pipeline.ts`,
    ],
    { encoding: "utf8" }
  );
  let promotedVersion: number | null = null;
  if (retrainPromote.status === 0) {
    const m = retrainPromote.stdout.match(/promoted v(\d+) \(status=active\)/);
    promotedVersion = m ? Number(m[1]) : null;
  }
  record(
    "retrain promote",
    retrainPromote.status === 0 && promotedVersion !== null,
    `exit=${retrainPromote.status}; promoted ${promotedVersion ? `v${promotedVersion}` : "<none>"}`,
    fails
  );

  // Verify in DB.
  if (promotedVersion !== null) {
    try {
      const rows = await sql<{ status: string; notes: string | null }[]>`
        SELECT status, notes FROM project_policies
        WHERE project_id = ${PROJECT_ID} AND version = ${promotedVersion} AND tag IS NULL
      `;
      const ok =
        rows[0]?.status === "active" &&
        (rows[0]?.notes ?? "").includes(SMOKE_NOTES_NEEDLE);
      record(
        "policy row in DB",
        ok,
        `v${promotedVersion} status=${rows[0]?.status}, notes_has_needle=${(rows[0]?.notes ?? "").includes(SMOKE_NOTES_NEEDLE)}`,
        fails
      );
    } catch (err) {
      record("policy row in DB", false, (err as Error).message, fails);
    }
  }

  // ---------- 6. Hot path actually loads it --------------------------------
  // Send a chat completion. The gateway should classify, route, and
  // return a model name different from "gpt-4o-mini" (the input).
  // Anything 200 + a non-input model in the response is proof the
  // loader didn't fall back to baseline.
  if (CI_MODE) {
    skip(
      "hot-path routed",
      "CI mode — skipping; needs gateway up + real upstream credentials"
    );
  } else {
    try {
      const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "smoke test ping" }],
          max_tokens: 8,
        }),
      });
      if (r.ok) {
        const j = (await r.json()) as { model?: string };
        record(
          "hot-path routed",
          j.model !== undefined && j.model !== "gpt-4o-mini",
          `landed=${j.model ?? "<missing>"}`,
          fails
        );
      } else {
        const txt = await r.text();
        record(
          "hot-path routed",
          false,
          `HTTP ${r.status} — ${txt.slice(0, 120)}`,
          fails
        );
      }
    } catch (err) {
      record("hot-path routed", false, (err as Error).message, fails);
    }
  }

  // ---------- 7. NOTIFY ----------------------------------------------------
  // Fire NOTIFY and re-issue a chat call. The gateway logs nothing on
  // a successful notify (by design), so we use "did the next request
  // still 200" as a sanity proxy. In CI mode we still fire the NOTIFY
  // (it's a one-line SQL call, no upstream cost) so we exercise the
  // pg_notify path itself; we just skip the re-issue chat call.
  if (CI_MODE) {
    try {
      await sql`SELECT pg_notify('tokensmart_policy_invalidate', ${JSON.stringify({ project_id: PROJECT_ID, tag: null })})`;
      pass(
        "NOTIFY emitted (CI mode)",
        "pg_notify call succeeded; downstream re-issue check skipped"
      );
    } catch (err) {
      record("NOTIFY emitted (CI mode)", false, (err as Error).message, fails);
    }
  } else {
    try {
      await sql`SELECT pg_notify('tokensmart_policy_invalidate', ${JSON.stringify({ project_id: PROJECT_ID, tag: null })})`;
      // Brief sleep so the notification handler runs before the next req.
      await new Promise((res) => setTimeout(res, 100));
      const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "post-NOTIFY ping" }],
          max_tokens: 4,
        }),
      });
      record(
        "NOTIFY → next req still healthy",
        r.ok,
        `HTTP ${r.status}`,
        fails
      );
    } catch (err) {
      record(
        "NOTIFY → next req still healthy",
        false,
        (err as Error).message,
        fails
      );
    }
  }

  // ---------- 8. Failure → alert dispatch ----------------------------------
  // Subscribe a one-off alert rule, force a failing retrain (a tag
  // with no observations is the cheapest way), assert the CLI's
  // stdout shows the alerts dispatch line.
  let smokeRuleId: string | null = null;
  try {
    const ruleRows = await sql<{ id: string }[]>`
      INSERT INTO alert_rules (project_id, event_type, webhook_url, email, enabled)
      VALUES (
        ${PROJECT_ID}, 'retrain_failed', NULL,
        'smoke-pipeline@tokensmart-test.local', TRUE
      )
      RETURNING id
    `;
    smokeRuleId = ruleRows[0]?.id ?? null;
  } catch (err) {
    // pre-existing rule? OK, skip; smoke is still meaningful as long
    // as the alert dispatch happens.
    log(`alert_rules INSERT skipped: ${(err as Error).message}`);
  }

  const failingRetrain = spawnSync(
    "bun",
    [
      "run",
      retrainScript,
      "--",
      "--project",
      PROJECT_ID,
      "--tag",
      "smoke-no-such-tag-anywhere",
    ],
    { encoding: "utf8" }
  );
  const alertDispatched =
    failingRetrain.stdout.includes("[alerts] email →") &&
    failingRetrain.stdout.includes("retrain_failed");
  record(
    "alert dispatched on retrain failure",
    alertDispatched,
    alertDispatched
      ? "found '[alerts] email → … (retrain_failed)' in stdout"
      : "alert dispatch line missing from stdout — RESEND key unset is fine, the LOG should still appear",
    fails
  );

  // ---------- 9. Cleanup ---------------------------------------------------
  try {
    if (smokeRuleId) {
      await sql`DELETE FROM alert_rules WHERE id = ${smokeRuleId}`;
    }
    await sql`
      DELETE FROM ab_results WHERE fingerprint LIKE ${SMOKE_FINGERPRINT_PREFIX + "%"}
    `;
    if (anchorWasSynthesized) {
      // Same fingerprint prefix scopes deletion to our row.
      await sql`
        DELETE FROM requests
        WHERE fingerprint = ${SMOKE_FINGERPRINT_PREFIX + "-anchor"}
      `;
    }
    if (promotedVersion !== null) {
      // Demote the smoke version + reactivate the prior version, so
      // the operator's gateway routes against pre-smoke state again.
      await sql.begin(async (tx) => {
        await tx`
          UPDATE project_policies SET status = 'rejected'
          WHERE project_id = ${PROJECT_ID} AND version = ${promotedVersion} AND tag IS NULL
        `;
        const prior = await tx<{ version: number }[]>`
          SELECT version FROM project_policies
          WHERE project_id = ${PROJECT_ID} AND tag IS NULL AND status = 'superseded'
          ORDER BY version DESC LIMIT 1
        `;
        if (prior[0]) {
          await tx`
            UPDATE project_policies SET status = 'active', activated_at = NOW()
            WHERE project_id = ${PROJECT_ID} AND tag IS NULL AND version = ${prior[0].version}
          `;
        }
      });
    }
    pass("cleanup", "removed seed rows + alert rule + reverted smoke policy");
  } catch (err) {
    record("cleanup", false, (err as Error).message, fails);
  }

  await sql.end({ timeout: 5 });
  console.log("");
  if (fails.count > 0) {
    console.error(`[smoke-pipeline] ${fails.count} stage(s) failed.`);
    process.exit(2);
  }
  log("all stages passed.");
  process.exit(0);
}

await main().catch((err) => {
  console.error("[smoke-pipeline] fatal:", err);
  process.exit(1);
});
