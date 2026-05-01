/**
 * v0.6.7 — failed requests must land in the `requests` ledger.
 *
 * Discovered during the v0.6.6 dogfooding loop: openclaw chat returned
 * HTTP 400, the operator clicked through to /requests in the dashboard,
 * and the row wasn't there. Root cause: the resolveProvider failure
 * path (no_template + no_credentials_for_provider) early-returned 400
 * without an `insertRequest` call. The L5 `ops_model_rejections`
 * aggregate captured the model name + hit-count, but the per-request
 * row needed for "show me the actual failure I'm investigating" was
 * missing.
 *
 * Other failure paths (loop-detected, plan-cap, budget-cap, upstream
 * 5xx) already inserted rows pre-v0.6.7. The fix is targeted at the
 * resolveProvider gap.
 *
 * This test pins the new contract end-to-end: a request for an unknown
 * model returns 400 to the caller AND a `status='error'` row appears
 * in `requests` with the descriptive reason, the asked model, and the
 * `X-Tokensmart-Request-Id` header value as the row id (so an operator
 * can deep-link from the response header to the row).
 *
 * Backend behavior:
 *   - SQLite mode (TOKENSMART_DATABASE_URL=:memory: or sqlite:...) →
 *     test runs hermetically in :memory:.
 *   - Postgres mode (default dev .env) → test connects to the
 *     developer's local Postgres. Skips with a helpful message when
 *     Postgres is unreachable instead of failing the whole suite.
 */

// Force :memory: SQLite for hermetic test execution. With Bun's
// single-process test runner + ESM module caching, once config.ts
// has been loaded by ANY earlier test file the `sql` driver is
// locked onto whatever DATABASE_URL was in scope at first import.
// We use dynamic imports inside beforeAll so this override actually
// takes effect when our file is the FIRST to import the gateway
// graph; if it's not first (full-suite run after a postgres-bound
// test imported config), the in-scope `sql` may still be Postgres
// — the beforeAll probe + per-test guard skip gracefully in that
// case so `bun test` stays green on a dev box without docker
// compose up. Run this file in isolation to verify SQLite mode:
//   bun test test/failed-request-observability.test.ts
process.env.DATABASE_URL = ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";
process.env.TOKENSMART_BASELINE_POLICY_ENABLED = "0";
process.env.TOKENSMART_CACHE_ENABLED = "0";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";

const FIXTURE_PROJECT_ID = `00000000-0000-4000-a000-${Math.floor(
  Math.random() * 1e12
)
  .toString(16)
  .padStart(12, "0")}`;
const FIXTURE_API_KEY_PLAINTEXT = `ts_test_${randomUUID().replace(/-/g, "")}`;
const FIXTURE_API_KEY_HASH = createHash("sha256")
  .update(FIXTURE_API_KEY_PLAINTEXT)
  .digest("hex");

type GatewaySql = (typeof import("../src/db"))["sql"];
let app: Hono;
let sql: GatewaySql;
let dbReachable = false;

beforeAll(async () => {
  const { runPendingMigrations } = await import("../src/migrate");
  const dbModule = await import("../src/db");
  const { chatRoutes } = await import("../src/routes/chat");
  sql = dbModule.sql;

  // Probe whether the configured backend is actually reachable.
  // SQLite (:memory:) is always reachable; Postgres needs a server.
  // The probe is bounded by an explicit 2s race so we don't sit at
  // postgres.js's default connect_timeout and hit Bun's per-hook
  // 5s budget — the whole test FILE would be marked failed in that
  // case, instead of just skipping these particular assertions.
  try {
    await Promise.race([
      sql<Array<{ ok: number }>>`SELECT 1 AS ok`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("probe timeout")), 2000)
      ),
    ]);
    dbReachable = true;
  } catch (err) {
    console.log(
      `[failed-obs] DB not reachable (${(err as Error).message}); skipping. ` +
        `Run \`docker compose up -d postgres\` (or unset DATABASE_URL) to enable.`
    );
    return;
  }

  app = new Hono();
  app.route("/", chatRoutes);

  await runPendingMigrations();
  // Idempotent fixture seed — wipe + re-insert so re-running the file
  // doesn't accumulate rows.
  await sql`DELETE FROM requests WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM api_keys WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM projects WHERE id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`
    INSERT INTO projects (id, name) VALUES (${FIXTURE_PROJECT_ID}, 'failed-obs-test')
  `;
  await sql`
    INSERT INTO api_keys (project_id, name, key, key_hash, key_prefix, key_last4)
    VALUES (
      ${FIXTURE_PROJECT_ID},
      'failed-obs-test-key',
      ${FIXTURE_API_KEY_PLAINTEXT},
      ${FIXTURE_API_KEY_HASH},
      ${FIXTURE_API_KEY_PLAINTEXT.slice(0, 7)},
      ${FIXTURE_API_KEY_PLAINTEXT.slice(-4)}
    )
  `;
});

afterAll(async () => {
  if (!sql || !dbReachable) return;
  await sql`DELETE FROM requests WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM api_keys WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM projects WHERE id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
});

async function postChat(body: Record<string, unknown>): Promise<{
  status: number;
  json: unknown;
  headers: Record<string, string>;
}> {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIXTURE_API_KEY_PLAINTEXT}`,
    },
    body: JSON.stringify(body),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, headers };
}

async function selectRow(requestId: string): Promise<{
  id: string;
  status: string;
  error: string | null;
  provider: string;
  model: string;
  cost_micro_cents: number;
  request_body: unknown;
} | null> {
  const rows = await sql<
    Array<{
      id: string;
      status: string;
      error: string | null;
      provider: string;
      model: string;
      cost_micro_cents: number;
      request_body: unknown;
    }>
  >`
    SELECT id, status, error, provider, model, cost_micro_cents, request_body
    FROM requests
    WHERE id = ${requestId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

describe("v0.6.7 — failed requests are observable in the requests ledger", () => {
  test("no_template (unknown model) → 400 + a status='error' row with descriptive reason", async () => {
    if (!dbReachable) return;
    const askedModel = `unknown-test-model-${Math.random().toString(36).slice(2, 8)}`;
    const res = await postChat({
      model: askedModel,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(400);
    const requestId = res.headers["x-tokensmart-request-id"];
    expect(requestId).toBeTruthy();

    expect(res.headers["x-tokensmart-asked-model"]).toBe(askedModel);
    expect(res.headers["x-tokensmart-landed-model"]).toBe(askedModel);
    // Since v0.6.4 (`4cc545b`), `routing_reason` persists baseline's
    // skip diagnostic even when no rewrite happened — the dashboard's
    // `humanRoutingReason` reads this column to explain WHY no route
    // fired. The exact reason depends on the gateway's boot state:
    //   - `disabled` / `no_artifact` — baseline policy is off (this
    //     file's env override forces this when it imports first).
    //   - `unknown_caller_model` — baseline is on but the asked model
    //     isn't in any policy bucket (full-suite runs, where an
    //     earlier test froze env before our override could land).
    // Both are valid emissions for an unknown-model 4xx; assert
    // membership so the test stays green across boot orderings
    // without losing the "we DO emit a skip reason now" signal.
    expect([
      "disabled",
      "no_artifact",
      "unknown_caller_model",
    ]).toContain(res.headers["x-tokensmart-routing-reason"]);
    expect(res.headers["x-tokensmart-cost-cents"]).toBe("0.000000");

    expect((res.json as { error?: { type?: string } })?.error?.type).toBe(
      "no_provider_for_model"
    );

    // Give the best-effort .catch() insert a microtask to flush.
    await new Promise((r) => setTimeout(r, 50));

    const row = await selectRow(requestId!);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("error");
    expect(row!.error).toContain("no_provider_for_model");
    expect(row!.error).toContain(askedModel);
    expect(row!.provider).toBe("unknown");
    expect(row!.model).toBe(askedModel);
    expect(row!.cost_micro_cents).toBe(0);
    // SQLite stores JSON as text; Postgres jsonb auto-parses. Adapt.
    const rawBody = row!.request_body;
    const stored: { model?: string; messages?: unknown } =
      typeof rawBody === "string"
        ? (JSON.parse(rawBody) as { model?: string; messages?: unknown })
        : (rawBody as { model?: string; messages?: unknown });
    expect(stored.model).toBe(askedModel);
    expect(Array.isArray(stored.messages)).toBe(true);
  });

  test("L5 aggregate row is ALSO written (per-request row + aggregate counter coexist)", async () => {
    if (!dbReachable) return;
    const askedModel = `unknown-coexist-${Math.random().toString(36).slice(2, 8)}`;
    await postChat({
      model: askedModel,
      messages: [{ role: "user", content: "hi" }],
    });

    await new Promise((r) => setTimeout(r, 50));

    const aggregate = await sql<
      Array<{ hit_count: number | string; reason: string }>
    >`
      SELECT hit_count, reason
      FROM ops_model_rejections
      WHERE model = ${askedModel.toLowerCase()}
      LIMIT 1
    `;
    // `hit_count` is BIGINT in Postgres → postgres.js returns it as a
    // string to preserve precision (SQLite returns a number). Coerce
    // explicitly so the assertion works on both backends.
    expect(Number(aggregate[0]?.hit_count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(aggregate[0]?.reason).toBe("no_template");
  });
});
