/**
 * Postgres integration test for the `/agents` view backend.
 *
 * Why a real-PG test instead of mocking `sql`: `getAgentSessions` /
 * `getAgentSessionTurns` query JSONB operators (`tags ? 'agent'`,
 * `tags->>'session'`, `jsonb_array_length(request_body->'tools')`) +
 * `PERCENTILE_DISC` window functions. None of those are faithful to
 * mock against — the only test that actually catches "I typoed an
 * operator" is one that runs the SQL against real Postgres.
 *
 * Auto-skips when no Postgres is reachable (default credentials match
 * the repo's `docker-compose.yml`). Set `TOKENSMART_TEST_PG_*` env to
 * point at a different cluster.
 *
 * Each run creates a hermetic temp database, applies every migration
 * file from `migrations/`, seeds a project + a couple of fake
 * (agent, session) traces with mixed tool / non-tool / loop /
 * budget-blocked rows, then asserts the rollup matches expectations.
 * Drops the temp DB on teardown — fail-safe.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const PG_HOST = process.env.TOKENSMART_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = Number(process.env.TOKENSMART_TEST_PG_PORT ?? "5432");
const PG_USER = process.env.TOKENSMART_TEST_PG_USER ?? "tokensmart";
const PG_PASS = process.env.TOKENSMART_TEST_PG_PASSWORD ?? "tokensmart_dev";
const PG_ADMIN_DB = process.env.TOKENSMART_TEST_PG_ADMIN_DB ?? "tokensmart";
const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../../../migrations");

let tempDbName: string | null = null;
let pgReachable = false;
let agentsApi: typeof import("../src/lib/db") | null = null;
let sql: postgres.Sql<{}> | null = null;

const FIXTURE_PROJECT_ID = "00000000-0000-0000-0000-00000000a000";
const FIXTURE_USER_ID = "00000000-0000-0000-0000-00000000b000";
const FIXTURE_API_KEY_ID = "00000000-0000-0000-0000-00000000c000";

async function isPostgresReachable(): Promise<boolean> {
  const adm = postgres({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database: PG_ADMIN_DB,
    max: 1,
    connect_timeout: 2,
  });
  try {
    await adm`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await adm.end({ timeout: 1 });
  }
}

async function createTempDatabase(): Promise<string> {
  const name = `ts_dashtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (!/^ts_dashtest_[a-z0-9_]+$/.test(name)) {
    throw new Error("internal: bad temp db name shape");
  }
  const adm = postgres({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database: PG_ADMIN_DB,
    max: 1,
  });
  try {
    await adm.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await adm.end({ timeout: 1 });
  }
  return name;
}

async function dropTempDatabase(name: string): Promise<void> {
  const adm = postgres({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database: PG_ADMIN_DB,
    max: 1,
  });
  try {
    await adm.unsafe(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = '${name}' AND pid <> pg_backend_pid()`
    );
    await adm.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  } catch (err) {
    console.warn(`[dashboard-pg-test] drop ${name} failed:`, err);
  } finally {
    await adm.end({ timeout: 1 });
  }
}

async function applyMigrations(s: postgres.Sql<{}>): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const f of files) {
    const body = readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
    try {
      await s.unsafe(body);
    } catch (err) {
      throw new Error(
        `migration ${f} failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}

async function seedFixtures(s: postgres.Sql<{}>): Promise<void> {
  await s`
    INSERT INTO users (id, email, plan)
    VALUES (${FIXTURE_USER_ID}, 'agents-pg-test@tokensmart.test', 'free')
    ON CONFLICT (id) DO NOTHING
  `;
  await s`
    INSERT INTO projects (id, user_id, name)
    VALUES (${FIXTURE_PROJECT_ID}, ${FIXTURE_USER_ID}, 'agents-test-project')
    ON CONFLICT (id) DO NOTHING
  `;
  await s`
    INSERT INTO api_keys (id, project_id, key, name)
    VALUES (${FIXTURE_API_KEY_ID}, ${FIXTURE_PROJECT_ID}, 'agents-test-key', 'agents-test')
    ON CONFLICT (id) DO NOTHING
  `;

  // Three turns for OpenClaw session "alpha":
  //   - Turn 1: success, no tools, $0.0010
  //   - Turn 2: success, WITH tools, $0.0020
  //   - Turn 3: loop_detected, $0
  // Plus two turns for AutoGPT session "bravo":
  //   - Turn 1: success, with tools, $0.0030
  //   - Turn 2: budget_exceeded, $0
  // Plus one untagged row that MUST NOT show up in either rollup.
  const baseRowMinimal = (overrides: {
    cost_micro_cents: number;
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    status: string;
    tags: Record<string, string>;
    has_tools: boolean;
  }) => {
    const requestBody = overrides.has_tools
      ? {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: { name: "search", description: "x", parameters: {} },
            },
          ],
        }
      : {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
        };
    return {
      project_id: FIXTURE_PROJECT_ID,
      api_key_id: FIXTURE_API_KEY_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      input_tokens: overrides.input_tokens,
      output_tokens: overrides.output_tokens,
      cost_micro_cents: overrides.cost_micro_cents,
      latency_ms: overrides.latency_ms,
      status: overrides.status,
      tags: overrides.tags,
      request_body: requestBody,
    };
  };

  const rows = [
    baseRowMinimal({
      cost_micro_cents: 1000,
      input_tokens: 100,
      output_tokens: 50,
      latency_ms: 200,
      status: "success",
      tags: { agent: "openclaw", session: "alpha", turn: "1" },
      has_tools: false,
    }),
    baseRowMinimal({
      cost_micro_cents: 2000,
      input_tokens: 150,
      output_tokens: 80,
      latency_ms: 400,
      status: "success",
      tags: { agent: "openclaw", session: "alpha", turn: "2" },
      has_tools: true,
    }),
    baseRowMinimal({
      cost_micro_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 5,
      status: "loop_detected",
      tags: { agent: "openclaw", session: "alpha", turn: "3" },
      has_tools: false,
    }),
    baseRowMinimal({
      cost_micro_cents: 3000,
      input_tokens: 200,
      output_tokens: 120,
      latency_ms: 600,
      status: "success",
      tags: { agent: "autogpt", session: "bravo", turn: "1" },
      has_tools: true,
    }),
    baseRowMinimal({
      cost_micro_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 5,
      status: "budget_exceeded",
      tags: { agent: "autogpt", session: "bravo", turn: "2" },
      has_tools: false,
    }),
    // A plan_limit_exceeded row in the openclaw session — this is
    // the regression we want to catch. Before the fix, this row
    // would silently bump error_count instead of plan_blocked_count,
    // hiding the "user out of quota" signal in /agents.
    baseRowMinimal({
      cost_micro_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 4,
      status: "plan_limit_exceeded",
      tags: { agent: "openclaw", session: "alpha", turn: "4" },
      has_tools: false,
    }),
    // Generic upstream "error" row — this is what error_count is
    // FOR (provider 5xx that retry+failover couldn't recover from).
    // Lives in the autogpt session so we can check both buckets in
    // one rollup query.
    baseRowMinimal({
      cost_micro_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 1500,
      status: "error",
      tags: { agent: "autogpt", session: "bravo", turn: "3" },
      has_tools: false,
    }),
    // Untagged row — proves the rollup excludes traffic without
    // (agent, session). If this leaks into the result we'll see one
    // extra session in the count.
    baseRowMinimal({
      cost_micro_cents: 9999,
      input_tokens: 999,
      output_tokens: 999,
      latency_ms: 999,
      status: "success",
      tags: {},
      has_tools: false,
    }),
  ];

  for (const r of rows) {
    await s`
      INSERT INTO requests (
        project_id, api_key_id, provider, model,
        input_tokens, output_tokens, cost_micro_cents, latency_ms,
        status, request_body, tags
      ) VALUES (
        ${r.project_id}, ${r.api_key_id}, ${r.provider}, ${r.model},
        ${r.input_tokens}, ${r.output_tokens}, ${r.cost_micro_cents}, ${r.latency_ms},
        ${r.status}, ${s.json(r.request_body)}, ${s.json(r.tags)}
      )
    `;
  }
}

/**
 * Routing-quality fixtures.
 *
 * Crafts a deliberately mixed traffic shape so getRoutingQuality has
 * something meaningful to roll up:
 *
 *   - 12 calls of (asked=gpt-5.2, landed=flash-lite) → 9 success, 1 error,
 *     2 loop-blocked. 75% success.
 *   - 8 calls of (asked=gpt-5.2, landed=flash) → 8 success. 100%.
 *   - 6 NATIVE calls to flash-lite directly (asked == landed) → 6 success.
 *     100% baseline.
 *   - 4 NATIVE calls to flash directly → 3 success, 1 error. 75% baseline.
 *
 * Asserted deltas:
 *   - rewrite (gpt-5.2 → flash-lite) success 75%, native flash-lite 100%
 *     → delta = -25pp (flagged: ≥ 5pp drop, ≥ 20 calls? — 12 < 20, NOT
 *     flagged. Test asserts delta but not the flag count.)
 *   - rewrite (gpt-5.2 → flash) success 100%, native flash 75%
 *     → delta = +25pp (positive, no flag).
 *
 * Untagged so they don't perturb the agent-rollup tests above (those
 * filter on `tags ? 'agent' AND tags ? 'session'`).
 */
async function seedRoutingFixtures(s: postgres.Sql<{}>): Promise<void> {
  type RoutingFixture = {
    asked: string | null;
    landed: string;
    status: string;
    cost_uc: number;
    latency_ms: number;
  };
  const FLASH_LITE_LANDED = "gemini-2.0-flash-lite";
  const fixtures: RoutingFixture[] = [
    // 12 rewrites gpt-5.2 → flash-lite: 9 success, 1 error, 2 loop_detected
    ...Array.from({ length: 9 }, () => ({
      asked: "gpt-5.2",
      landed: FLASH_LITE_LANDED,
      status: "success",
      cost_uc: 50,
      latency_ms: 700,
    })),
    {
      asked: "gpt-5.2",
      landed: FLASH_LITE_LANDED,
      status: "error",
      cost_uc: 0,
      latency_ms: 1500,
    },
    ...Array.from({ length: 2 }, () => ({
      asked: "gpt-5.2",
      landed: FLASH_LITE_LANDED,
      status: "loop_detected",
      cost_uc: 0,
      latency_ms: 5,
    })),
    // 8 rewrites gpt-5.2 → flash, all success
    ...Array.from({ length: 8 }, () => ({
      asked: "gpt-5.2",
      landed: "gpt-4o",
      status: "success",
      cost_uc: 800,
      latency_ms: 1100,
    })),
    // 6 native calls to flash-lite, all success
    ...Array.from({ length: 6 }, () => ({
      asked: null,
      landed: FLASH_LITE_LANDED,
      status: "success",
      cost_uc: 60,
      latency_ms: 650,
    })),
    // 4 native calls to flash: 3 success, 1 error
    ...Array.from({ length: 3 }, () => ({
      asked: null,
      landed: "gpt-4o",
      status: "success",
      cost_uc: 850,
      latency_ms: 1200,
    })),
    {
      asked: null,
      landed: "gpt-4o",
      status: "error",
      cost_uc: 0,
      latency_ms: 1800,
    },
  ];
  for (const f of fixtures) {
    await s`
      INSERT INTO requests (
        project_id, api_key_id, provider, model, original_model,
        input_tokens, output_tokens, cost_micro_cents, latency_ms,
        status, request_body, tags
      ) VALUES (
        ${FIXTURE_PROJECT_ID}, ${FIXTURE_API_KEY_ID}, 'openai',
        ${f.landed}, ${f.asked},
        100, 50, ${f.cost_uc}, ${f.latency_ms},
        ${f.status},
        ${s.json({ model: f.asked ?? f.landed, messages: [] })},
        ${s.json({})}
      )
    `;
  }

  // Bucket-tagged fixtures (added in migration 025_routing_reason).
  // Land on `gemini-2.5-pro` (NOT flash-lite) so these rows don't
  // perturb the existing (gpt-5.2 → flash-lite) rewrite pair count
  // the older tests above pin down. The bucket aggregation query
  // groups by `routing_bucket` regardless of landing model, so the
  // bucket-level math here is independent.
  //
  //   5 chat:medium  → all success
  //   4 code:hard    → 3 success, 1 upstream error
  //   2 reasoning:hard → both blocked by loop detector. Bucket appears
  //                       in by_bucket but reaches 0 upstream samples
  //                       → success_rate must be null (NOT 0%).
  type BucketFixture = {
    landed: string;
    bucket: string;
    status: string;
    routing_saving_uc: number;
  };
  const BUCKET_LANDED = "gemini-2.5-pro";
  const bucketFixtures: BucketFixture[] = [
    ...Array.from({ length: 5 }, () => ({
      landed: BUCKET_LANDED,
      bucket: "chat:medium",
      status: "success",
      routing_saving_uc: 800,
    })),
    ...Array.from({ length: 3 }, () => ({
      landed: BUCKET_LANDED,
      bucket: "code:hard",
      status: "success",
      routing_saving_uc: 1200,
    })),
    {
      landed: BUCKET_LANDED,
      bucket: "code:hard",
      status: "error",
      routing_saving_uc: 0,
    },
    ...Array.from({ length: 2 }, () => ({
      landed: BUCKET_LANDED,
      bucket: "reasoning:hard",
      status: "loop_detected",
      routing_saving_uc: 0,
    })),
  ];
  for (const f of bucketFixtures) {
    await s`
      INSERT INTO requests (
        project_id, api_key_id, provider, model, original_model,
        input_tokens, output_tokens, cost_micro_cents, latency_ms,
        routing_saving_micro_cents,
        status, request_body, tags,
        routing_reason, routing_bucket
      ) VALUES (
        ${FIXTURE_PROJECT_ID}, ${FIXTURE_API_KEY_ID}, 'openai',
        ${f.landed}, 'gpt-5.2',
        100, 30, 50, 700, ${f.routing_saving_uc},
        ${f.status},
        ${s.json({ model: "gpt-5.2", messages: [] })},
        ${s.json({})},
        ${"baseline:" + f.bucket + ":q=0.83:n=19:eps=0.10"},
        ${f.bucket}
      )
    `;
  }
}

beforeAll(async () => {
  pgReachable = await isPostgresReachable();
  if (!pgReachable) {
    console.log(
      `[dashboard-pg-test] Postgres at ${PG_HOST}:${PG_PORT} not reachable — skipping. ` +
        `Run \`docker compose up -d postgres\` to enable.`
    );
    return;
  }
  tempDbName = await createTempDatabase();
  const url = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${tempDbName}`;
  // Set BEFORE the dynamic import so the singleton inside lib/db
  // resolves to our temp DB. lib/db throws on missing DATABASE_URL,
  // which is exactly the contract we want here.
  process.env.DATABASE_URL = url;
  // Open a side-channel sql for direct fixture seeding (mirrors what
  // the gateway's e2e-pg script does — keeps test setup readable
  // without going through the dashboard's helper functions).
  sql = postgres(url, { max: 4 });
  await applyMigrations(sql);
  await seedFixtures(sql);
  await seedRoutingFixtures(sql);
  // Defer the import until env is set. Bun caches the module on
  // first import, so this works as long as no earlier test file in
  // the same `bun test` run pulled lib/db. Today only saml.test.ts
  // exists, and it doesn't touch the DB. If you add another test
  // that imports lib/db statically before this one runs, that test
  // will throw on missing DATABASE_URL — preserve that behavior so
  // the breakage is loud.
  if (!existsSync(path.resolve(import.meta.dir, "../src/lib/db.ts"))) {
    throw new Error("internal: dashboard lib/db.ts not found");
  }
  agentsApi = await import("../src/lib/db");
});

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 1 });
    sql = null;
  }
  if (tempDbName) {
    await dropTempDatabase(tempDbName);
    tempDbName = null;
  }
});

describe("getAgentSessions", () => {
  test("rolls up exactly the (agent, session) pairs that have both tags", () => {
    if (!pgReachable || !agentsApi) {
      console.log("  → skipped (Postgres not reachable)");
      return;
    }
  });

  test("openclaw + autogpt session present, untagged row excluded", async () => {
    if (!pgReachable || !agentsApi) return;
    const sessions = await agentsApi.getAgentSessions(7, 100, undefined);
    // Exactly two sessions; the untagged "leak probe" row must not
    // appear as its own bucket because the WHERE filter requires
    // both `agent` and `session` tags.
    expect(sessions.length).toBe(2);
    const byAgent = Object.fromEntries(sessions.map((s) => [s.agent, s]));
    expect(byAgent.openclaw).toBeDefined();
    expect(byAgent.autogpt).toBeDefined();
  });

  test("openclaw alpha session aggregates correctly", async () => {
    if (!pgReachable || !agentsApi) return;
    const sessions = await agentsApi.getAgentSessions(7, 100, undefined);
    const oc = sessions.find((s) => s.agent === "openclaw");
    expect(oc).toBeDefined();
    if (!oc) return;
    // Four rows: turns 1/2/3/4 — four distinct turns.
    expect(oc.turn_count).toBe(4);
    expect(oc.request_count).toBe(4);
    // 1000 + 2000 + 0 + 0 = 3000 micro_cents.
    expect(oc.total_cost_micro_cents).toBe(3000);
    // 100 + 150 + 0 + 0 = 250 in tokens.
    expect(oc.total_input_tokens).toBe(250);
    // Turn 2 has tools; turns 1/3/4 don't → 1 tool-capable.
    expect(oc.tool_capable_count).toBe(1);
    // One loop_detected row, one plan_limit_exceeded row, no
    // budget_exceeded, no generic-error.
    expect(oc.loop_blocked_count).toBe(1);
    expect(oc.budget_blocked_count).toBe(0);
    expect(oc.plan_blocked_count).toBe(1);
    // The plan-limit row must NOT inflate error_count — that's the
    // regression this fixture catches.
    expect(oc.error_count).toBe(0);
  });

  test("autogpt bravo session aggregates correctly (incl. budget block + upstream error)", async () => {
    if (!pgReachable || !agentsApi) return;
    const sessions = await agentsApi.getAgentSessions(7, 100, undefined);
    const ag = sessions.find((s) => s.agent === "autogpt");
    expect(ag).toBeDefined();
    if (!ag) return;
    // Three rows: turns 1/2/3 — three distinct turns.
    expect(ag.turn_count).toBe(3);
    // Three rows: success / budget_exceeded / error.
    expect(ag.request_count).toBe(3);
    expect(ag.total_cost_micro_cents).toBe(3000);
    expect(ag.tool_capable_count).toBe(1);
    expect(ag.budget_blocked_count).toBe(1);
    expect(ag.loop_blocked_count).toBe(0);
    expect(ag.plan_blocked_count).toBe(0);
    // Generic upstream "error" rows DO land in error_count.
    expect(ag.error_count).toBe(1);
  });

  test("scope=[] returns no sessions (no projects in user's scope)", async () => {
    if (!pgReachable || !agentsApi) return;
    const sessions = await agentsApi.getAgentSessions(7, 100, []);
    expect(sessions).toEqual([]);
  });

  test("scope=[unknownProject] returns no sessions", async () => {
    if (!pgReachable || !agentsApi) return;
    const sessions = await agentsApi.getAgentSessions(
      7,
      100,
      ["00000000-0000-0000-0000-00000000ffff"]
    );
    expect(sessions).toEqual([]);
  });
});

describe("getAgentSessionTurns", () => {
  test("returns turns in chronological order with tools/error metadata", async () => {
    if (!pgReachable || !agentsApi) return;
    const turns = await agentsApi.getAgentSessionTurns(
      "openclaw",
      "alpha",
      100,
      undefined
    );
    expect(turns.length).toBe(4);
    // Turns inserted in sequence (1, 2, 3, 4) → ordered by created_at ASC.
    expect(turns[0]?.turn).toBe("1");
    expect(turns[0]?.has_tools).toBe(false);
    expect(turns[0]?.status).toBe("success");

    expect(turns[1]?.turn).toBe("2");
    expect(turns[1]?.has_tools).toBe(true);

    expect(turns[2]?.turn).toBe("3");
    expect(turns[2]?.status).toBe("loop_detected");
    expect(turns[2]?.cost_micro_cents).toBe(0);

    expect(turns[3]?.turn).toBe("4");
    expect(turns[3]?.status).toBe("plan_limit_exceeded");
    expect(turns[3]?.cost_micro_cents).toBe(0);
  });

  test("returns empty for a session that doesn't exist", async () => {
    if (!pgReachable || !agentsApi) return;
    const turns = await agentsApi.getAgentSessionTurns(
      "openclaw",
      "no-such-session",
      100,
      undefined
    );
    expect(turns).toEqual([]);
  });

  test("respects scope filtering (empty scope → empty result)", async () => {
    if (!pgReachable || !agentsApi) return;
    const turns = await agentsApi.getAgentSessionTurns(
      "openclaw",
      "alpha",
      100,
      []
    );
    expect(turns).toEqual([]);
  });
});

describe("getRoutingQuality", () => {
  test("rewrites are separated from natives, both bucketed by (asked, landed)", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, undefined);
    // Three distinct rewrite pairs in the fixture set:
    //   - (gpt-5.2 → flash-lite)   [the original 12 rows]
    //   - (gpt-5.2 → flash)        [the original 8 rows]
    //   - (gpt-5.2 → gemini-2.5-pro) [the bucket-tagged fixtures, 10 rows]
    expect(q.rewrites.length).toBe(3);
    // Two distinct native landings in the fixture (flash-lite, flash).
    // Plus possibly other rows from the agent-rollup fixtures (those
    // are non-routed, so they end up in `natives` too). We assert
    // ≥ 2 instead of equality so adding new agent fixtures elsewhere
    // doesn't break this test.
    expect(q.natives.length).toBeGreaterThanOrEqual(2);
  });

  test("rewrite (gpt-5.2 → flash-lite) success rate excludes loop_blocked from denominator", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, undefined);
    const pair = q.rewrites.find(
      (r) =>
        r.asked === "gpt-5.2" &&
        r.landed === "gemini-2.0-flash-lite"
    );
    expect(pair).toBeDefined();
    if (!pair) return;
    // Fixture: 9 success, 1 error, 2 loop_detected → total=12.
    // success_rate denominator is rows that ACTUALLY REACHED upstream
    // = success + upstream_errors = 10 (loop blocks fired BEFORE the
    // call so they don't count against routing quality). 9/10 = 90%.
    expect(pair.total).toBe(12);
    expect(pair.success).toBe(9);
    expect(pair.upstream_errors).toBe(1);
    expect(pair.loop_blocked).toBe(2);
    expect(pair.success_rate_pct).toBe(90);
    // Baseline: 6 native flash-lite calls, all success → 100%.
    expect(pair.baseline_success_rate_pct).toBe(100);
    expect(pair.baseline_total).toBe(6);
    expect(pair.success_rate_delta_pct).toBe(-10);
  });

  test("rewrite (gpt-5.2 → flash) computes 100% success vs 75% native baseline (positive delta)", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, undefined);
    const pair = q.rewrites.find(
      (r) =>
        r.asked === "gpt-5.2" &&
        r.landed === "gpt-4o"
    );
    expect(pair).toBeDefined();
    if (!pair) return;
    expect(pair.total).toBe(8);
    expect(pair.success).toBe(8);
    expect(pair.success_rate_pct).toBe(100);
    expect(pair.baseline_success_rate_pct).toBe(75);
    expect(pair.success_rate_delta_pct).toBe(25);
  });

  test("native baseline carries the directly-asked counts (no rewrite confusion)", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, undefined);
    const flashLiteNative = q.natives.find(
      (n) => n.landed === "gemini-2.0-flash-lite"
    );
    expect(flashLiteNative).toBeDefined();
    if (!flashLiteNative) return;
    expect(flashLiteNative.rewritten).toBe(false);
    expect(flashLiteNative.total).toBe(6);
    expect(flashLiteNative.success_rate_pct).toBe(100);
    expect(flashLiteNative.upstream_errors).toBe(0);
  });

  test("scope=[] returns empty rewrite + native lists", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, []);
    expect(q.rewrites).toEqual([]);
    expect(q.natives).toEqual([]);
  });

  test("by_bucket aggregates each (task_type, complexity) bucket independently", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, undefined);
    const byBucket = Object.fromEntries(
      q.by_bucket.map((b) => [b.bucket, b])
    );
    expect(byBucket["chat:medium"]).toBeDefined();
    expect(byBucket["code:hard"]).toBeDefined();
    expect(byBucket["reasoning:hard"]).toBeDefined();

    // chat:medium fixture: 5 success → 100% over reached=5.
    expect(byBucket["chat:medium"]?.total).toBe(5);
    expect(byBucket["chat:medium"]?.success).toBe(5);
    expect(byBucket["chat:medium"]?.success_rate_pct).toBe(100);
    expect(byBucket["chat:medium"]?.avg_routing_saving_micro_cents).toBe(800);

    // code:hard fixture: 3 success + 1 error → 75% over reached=4.
    expect(byBucket["code:hard"]?.total).toBe(4);
    expect(byBucket["code:hard"]?.success).toBe(3);
    expect(byBucket["code:hard"]?.upstream_errors).toBe(1);
    expect(byBucket["code:hard"]?.success_rate_pct).toBe(75);
    // Avg saving = (3*1200 + 1*0) / 4 = 900µc.
    expect(byBucket["code:hard"]?.avg_routing_saving_micro_cents).toBe(900);
  });

  test("by_bucket success_rate is null when 100% of rows were blocked (no upstream samples)", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, undefined);
    const reasoning = q.by_bucket.find((b) => b.bucket === "reasoning:hard");
    expect(reasoning).toBeDefined();
    if (!reasoning) return;
    // 2 loop_detected, 0 success, 0 error → reached upstream = 0 →
    // success_rate must be null (NOT 0%, that would imply the model
    // failed; in fact the request never even reached the model).
    expect(reasoning.total).toBe(2);
    expect(reasoning.loop_blocked).toBe(2);
    expect(reasoning.success).toBe(0);
    expect(reasoning.upstream_errors).toBe(0);
    expect(reasoning.success_rate_pct).toBeNull();
  });

  test("scope=[] also empties by_bucket", async () => {
    if (!pgReachable || !agentsApi) return;
    const q = await agentsApi.getRoutingQuality(7, []);
    expect(q.by_bucket).toEqual([]);
  });

  test("baseline is null when no native traffic exists for the landing model", async () => {
    if (!pgReachable || !agentsApi || !sql) return;
    // Insert one rewrite to a model with no native counterpart in the
    // fixture, verify baseline_success_rate_pct = null and delta = null.
    await sql`
      INSERT INTO requests (
        project_id, api_key_id, provider, model, original_model,
        input_tokens, output_tokens, cost_micro_cents, latency_ms,
        status, request_body, tags
      ) VALUES (
        ${FIXTURE_PROJECT_ID}, ${FIXTURE_API_KEY_ID}, 'openai',
        'claude-3-5-sonnet-latest',  -- landed model w/ no native traffic
        'gpt-5.2',
        50, 25, 200, 600,
        'success',
        ${sql.json({ model: "gpt-5.2", messages: [] })},
        ${sql.json({})}
      )
    `;
    const q = await agentsApi.getRoutingQuality(7, undefined);
    const orphan = q.rewrites.find(
      (r) => r.landed === "claude-3-5-sonnet-latest"
    );
    expect(orphan).toBeDefined();
    if (!orphan) return;
    expect(orphan.baseline_success_rate_pct).toBeNull();
    expect(orphan.baseline_total).toBe(0);
    expect(orphan.success_rate_delta_pct).toBeNull();
  });
});
