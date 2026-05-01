/**
 * Postgres-flavored end-to-end verification.
 *
 * Mirrors the SQLite-mode `e2e-verify.ts` but covers the production
 * code paths that SQLite mode skips by design:
 *   - Plan-tier reservation (per-user caps; users table is Postgres-only).
 *   - Unknown-price model reservation fallback (the bug class where
 *     a never-before-seen model id silently bypasses budget gating).
 *
 * Setup contract:
 *   1. The repo's docker-compose Postgres must be up
 *      (`docker compose up -d postgres`). DEFAULT credentials in
 *      docker-compose.yml are assumed; override via TOKENSMART_E2E_PG_*.
 *   2. Each run creates a fresh DB so the test is hermetic and can run
 *      multiple times without data poisoning. The DB is dropped on
 *      teardown — fail-safely, even on assertion failure.
 *
 * Scenarios:
 *   A.  Persistent 5xx surfaces as 502 (failover bug fix carried to PG).
 *   A2. Transient 5xx then 200 succeeds via retry.
 *   B.  Concurrent burst > project budget → some get budget_exceeded.
 *   C.  Identical prompt past threshold → loop_detected, durable rows.
 *   D.  OpenClaw attribution: response carries X-Request-Id; tags persist.
 *   E1. Plan reservation: concurrent burst > Free-tier daily cap →
 *       some get plan_limit_exceeded with code=plan_limit_exceeded.
 *   E2. Unknown-price model: budget reservation uses family_max
 *       fallback (estimate > 0) AND tags carry reservation_basis.
 */

import { spawn, type Subprocess } from "bun";
import path from "node:path";
import postgres from "postgres";

const GATEWAY_PORT = 18890;
const MOCK_PORT = 18891;
const DEV_KEY = "tokensmart-e2e-pg-key";
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const PG_HOST = process.env.TOKENSMART_E2E_PG_HOST ?? "127.0.0.1";
const PG_PORT = Number(process.env.TOKENSMART_E2E_PG_PORT ?? "5432");
const PG_USER = process.env.TOKENSMART_E2E_PG_USER ?? "tokensmart";
const PG_PASS = process.env.TOKENSMART_E2E_PG_PASSWORD ?? "tokensmart_dev";
const PG_ADMIN_DB =
  process.env.TOKENSMART_E2E_PG_ADMIN_DB ?? "tokensmart";

type MockMode =
  | { kind: "ok" }
  | { kind: "ok_slow"; delayMs: number }
  | { kind: "always_500" }
  | { kind: "five_hundred_then_ok"; remaining500s: number };

let mockMode: MockMode = { kind: "ok" };
let mockServer: ReturnType<typeof Bun.serve> | null = null;
let mockHits = 0;

function setMockMode(mode: MockMode): void {
  mockMode = mode;
  mockHits = 0;
}

function startMockUpstream(): void {
  mockServer = Bun.serve({
    port: MOCK_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      mockHits++;
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat/completions")) {
        if (mockMode.kind === "always_500") {
          return Response.json(
            { error: { message: "mock: always 500" } },
            { status: 500 }
          );
        }
        if (mockMode.kind === "five_hundred_then_ok") {
          if (mockMode.remaining500s > 0) {
            mockMode.remaining500s--;
            return Response.json(
              { error: { message: "mock: temporary 500" } },
              { status: 500 }
            );
          }
        }
        if (mockMode.kind === "ok_slow") {
          // Hold the upstream request open so multiple gateway-side
          // reservations stay in-flight at once. Without this delay the
          // mock returns in <1ms, every reservation finalises/releases
          // before the next one even begins, and the budget gate looks
          // like a no-op even though the code is correct.
          await Bun.sleep(mockMode.delayMs);
        }
        const body = (await req.json().catch(() => ({}))) as {
          model?: string;
        };
        return Response.json(
          {
            id: `chatcmpl-mock-${Date.now()}`,
            object: "chat.completion",
            model: body.model ?? "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
          { status: 200 }
        );
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  console.log(`[e2e-pg] mock upstream up on ${MOCK_URL}`);
}

function adminConn() {
  return postgres({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database: PG_ADMIN_DB,
    max: 1,
  });
}

function dbConn(database: string) {
  return postgres({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database,
    max: 4,
  });
}

async function createTempDatabase(): Promise<string> {
  const name = `ts_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const adm = adminConn();
  try {
    // Identifiers in postgres.js sql`` template aren't safely composable
    // for DDL like CREATE DATABASE, so we hand-quote after asserting the
    // name shape. Name is fully under our control (no user input) so
    // this is safe; the regex is belt-and-braces.
    if (!/^ts_e2e_[a-z0-9_]+$/.test(name)) {
      throw new Error("internal: bad temp db name");
    }
    await adm.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await adm.end();
  }
  console.log(`[e2e-pg] created database ${name}`);
  return name;
}

async function dropTempDatabase(name: string): Promise<void> {
  const adm = adminConn();
  try {
    // Force-disconnect any connections (gateway may not have finished
    // its own teardown yet) before DROP — Postgres rejects the drop
    // otherwise with "database is being accessed by other users".
    await adm.unsafe(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = '${name}' AND pid <> pg_backend_pid()`
    );
    await adm.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  } catch (err) {
    console.warn(`[e2e-pg] drop database ${name} failed:`, err);
  } finally {
    await adm.end();
  }
}

function databaseUrlFor(name: string): string {
  return `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${name}`;
}

async function waitForGateway(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${GATEWAY_URL}/health`);
      if (r.ok) return;
    } catch {
      // gateway not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`gateway did not come up within ${timeoutMs}ms`);
}

function startGateway(databaseUrl: string): Subprocess {
  const child = spawn({
    cmd: ["bun", "run", "src/index.ts"],
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      OPENAI_API_KEY: "sk-mock-fake-key",
      OPENAI_BASE_URL: MOCK_URL + "/v1",
      TOKENSMART_AUTO_MIGRATE: "1",
      TOKENSMART_BASELINE_POLICY_ENABLED: "0",
      TOKENSMART_CACHE_ENABLED: "0",
      TOKENSMART_RETRY_MAX_ATTEMPTS: "2",
      TOKENSMART_RETRY_BASE_DELAY_MS: "10",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      process.stdout.write("[gw] " + dec.decode(r.value));
    }
  })();
  void (async () => {
    const reader = child.stderr.getReader();
    const dec = new TextDecoder();
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      process.stderr.write("[gw err] " + dec.decode(r.value));
    }
  })();
  return child;
}

function gatewayHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_KEY}`,
  };
}

async function chatRequest(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{
  status: number;
  json: unknown;
  requestId: string | null;
}> {
  const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { ...gatewayHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return {
    status: r.status,
    json,
    requestId:
      r.headers.get("x-tokensmart-request-id") ??
      r.headers.get("x-request-id"),
  };
}

type Fixtures = {
  projectId: string;
  apiKeyId: string;
  userId: string;
};

/**
 * Mint a project + plan-bearing user + a known plaintext API key.
 * Returns the IDs the scenarios need.
 *
 * The dev seed key from migration 001 ("tokensmart-dev-key") is fine
 * for project-budget tests, but plan reservation needs the project's
 * owning user to carry a plan tier. Mint a fresh user with a Free
 * plan (the strictest daily cap) so the plan-reservation scenario
 * actually has a ceiling to bump into.
 */
async function seedFixtures(databaseUrl: string): Promise<Fixtures> {
  const sql = dbConn(databaseUrl.split("/").pop()!);
  try {
    // Make sure schema_migrations was populated by gateway boot.
    const migrations = await sql<{ filename: string }[]>`
      SELECT filename FROM schema_migrations ORDER BY filename
    `;
    if (migrations.length === 0) {
      throw new Error("gateway didn't apply migrations before fixtures ran");
    }

    // Hosted-mode user with a known Free plan tier — exists in the
    // canonical schema (migrations/011 organisations + plan column on
    // users).  We bypass auth entirely; the gateway uses the api_keys
    // row → projects.user_id chain to resolve plan context.
    const userRows = await sql<{ id: string }[]>`
      INSERT INTO users (email, plan)
      VALUES ('e2e-pg@tokensmart.test', 'free')
      RETURNING id
    `;
    const userId = userRows[0]!.id;

    const projectRows = await sql<{ id: string }[]>`
      INSERT INTO projects (user_id, name)
      VALUES (${userId}, 'e2e-pg-project')
      RETURNING id
    `;
    const projectId = projectRows[0]!.id;

    // Plaintext-key column for legacy lookup; key_hash for the modern
    // path. findApiKey() probes both.
    const keyHash = await sql<{ h: string }[]>`
      SELECT ENCODE(DIGEST(${DEV_KEY}, 'sha256'), 'hex') AS h
    `;
    const apiKeyRows = await sql<{ id: string }[]>`
      INSERT INTO api_keys (project_id, key, key_hash, name)
      VALUES (${projectId}, ${DEV_KEY}, ${keyHash[0]!.h}, 'e2e-pg')
      RETURNING id
    `;
    const apiKeyId = apiKeyRows[0]!.id;

    return { projectId, apiKeyId, userId };
  } finally {
    await sql.end();
  }
}

async function setTinyProjectBudget(
  databaseUrl: string,
  projectId: string,
  limitMicroCents = 1000
): Promise<void> {
  const sql = dbConn(databaseUrl.split("/").pop()!);
  try {
    await sql`DELETE FROM budget_reservations WHERE project_id = ${projectId}`;
    await sql`DELETE FROM budgets WHERE project_id = ${projectId}`;
    await sql`
      INSERT INTO budgets (project_id, period, limit_micro_cents, enabled)
      VALUES (${projectId}, 'daily', ${limitMicroCents}, TRUE)
    `;
  } finally {
    await sql.end();
  }
}

async function clearBudgetAndPlanReservations(
  databaseUrl: string,
  projectId: string,
  userId: string
): Promise<void> {
  const sql = dbConn(databaseUrl.split("/").pop()!);
  try {
    await sql`DELETE FROM budget_reservations WHERE project_id = ${projectId}`;
    await sql`DELETE FROM budgets WHERE project_id = ${projectId}`;
    await sql`DELETE FROM plan_reservations WHERE user_id = ${userId}`;
  } finally {
    await sql.end();
  }
}

async function clearLoopState(
  databaseUrl: string,
  projectId: string
): Promise<void> {
  const sql = dbConn(databaseUrl.split("/").pop()!);
  try {
    await sql`DELETE FROM loop_events WHERE project_id = ${projectId}`;
  } finally {
    await sql.end();
  }
}

type ScenarioResult = {
  name: string;
  passed: boolean;
  detail: string;
};

const results: ScenarioResult[] = [];

async function scenarioPersistentUpstream5xx(): Promise<void> {
  const name = "A. persistent upstream 5xx → 502 (PG)";
  setMockMode({ kind: "always_500" });
  const r = await chatRequest({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "scenario A unique probe" }],
  });
  results.push({
    name,
    passed: r.status === 502,
    detail: `status=${r.status}, mock_hits=${mockHits}`,
  });
}

async function scenarioRecoverableRetrySucceeds(): Promise<void> {
  const name = "A2. transient 500 then 200 → succeeds via retry (PG)";
  setMockMode({ kind: "five_hundred_then_ok", remaining500s: 1 });
  const r = await chatRequest({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "scenario A2 unique probe" }],
  });
  results.push({
    name,
    passed: r.status === 200,
    detail: `status=${r.status}, mock_hits=${mockHits}`,
  });
}

async function scenarioBudgetReservation(
  databaseUrl: string,
  projectId: string,
  userId: string
): Promise<void> {
  const name = "B. concurrent burst > project budget → some get budget_exceeded (PG)";
  // Slow-mock so multiple reservations stay pending at once; without
  // it the mock returns in <1ms and reservations release between
  // requests, masking the protection.
  setMockMode({ kind: "ok_slow", delayMs: 200 });
  await clearBudgetAndPlanReservations(databaseUrl, projectId, userId);
  await setTinyProjectBudget(databaseUrl, projectId, 1000);

  const inflight: Promise<{ status: number; json: unknown }>[] = [];
  for (let i = 0; i < 8; i++) {
    inflight.push(
      chatRequest({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `pg budget burst probe ${i} ${Math.random()}`,
          },
        ],
      })
    );
  }
  const all = await Promise.all(inflight);
  const blockedCount = all.filter(
    (r) => r.status === 429 && JSON.stringify(r.json).includes("budget_exceeded")
  ).length;

  const sql = dbConn(databaseUrl.split("/").pop()!);
  let pending = 0;
  let released = 0;
  try {
    const p = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM budget_reservations
      WHERE project_id = ${projectId} AND status = 'pending'
    `;
    pending = p[0]!.total;
    const r = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM budget_reservations
      WHERE project_id = ${projectId} AND status = 'released'
    `;
    released = r[0]!.total;
  } finally {
    await sql.end();
  }
  await clearBudgetAndPlanReservations(databaseUrl, projectId, userId);

  results.push({
    name,
    passed: blockedCount > 0 && pending === 0,
    detail: `requests=${all.length}, budget_blocked=${blockedCount}, leftover_pending=${pending}, released=${released}`,
  });
}

async function scenarioLoopDetector(
  databaseUrl: string,
  projectId: string
): Promise<void> {
  const name = "C. identical prompt past threshold → loop_detected durable (PG)";
  await clearLoopState(databaseUrl, projectId);
  setMockMode({ kind: "ok" });
  const body = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "pg loop probe constant" }],
  };
  let lastStatus = 0;
  let lastJson: unknown = null;
  for (let i = 0; i < 12; i++) {
    const r = await chatRequest(body);
    lastStatus = r.status;
    lastJson = r.json;
    if (r.status === 403) break;
  }
  const isLoop =
    lastStatus === 403 &&
    typeof lastJson === "object" &&
    lastJson !== null &&
    JSON.stringify(lastJson).includes("loop_detected");
  let durableCount = 0;
  if (isLoop) {
    const sql = dbConn(databaseUrl.split("/").pop()!);
    try {
      const rows = await sql<{ total: number }[]>`
        SELECT COUNT(*)::int AS total FROM loop_events
        WHERE project_id = ${projectId}
      `;
      durableCount = rows[0]!.total;
    } finally {
      await sql.end();
    }
  }
  results.push({
    name,
    passed: isLoop && durableCount > 0,
    detail: `final_status=${lastStatus}, durable_loop_rows=${durableCount}`,
  });
}

async function scenarioOpenclawAttribution(
  databaseUrl: string
): Promise<void> {
  const name =
    "D. OpenClaw attribution: response carries X-Request-Id and tags persist (PG)";
  setMockMode({ kind: "ok" });
  const r = await chatRequest(
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: `pg attribution probe ${Math.random()}` },
      ],
    },
    {
      "x-ts-agent": "openclaw",
      "x-ts-session": "s_pg_42",
      "x-ts-turn": "9",
      "x-ts-channel": "ide",
      "x-ts-tag": "feature=pg_test",
    }
  );
  let rowFound = false;
  let tagsOk = false;
  if (r.requestId) {
    const sql = dbConn(databaseUrl.split("/").pop()!);
    try {
      const rows = await sql<{ id: string; tags: Record<string, string> }[]>`
        SELECT id, tags FROM requests WHERE id = ${r.requestId} LIMIT 1
      `;
      if (rows[0]) {
        rowFound = true;
        const t = rows[0].tags;
        tagsOk =
          t.agent === "openclaw" &&
          t.session === "s_pg_42" &&
          t.turn === "9" &&
          t.channel === "ide" &&
          t.feature === "pg_test";
      }
    } finally {
      await sql.end();
    }
  }
  results.push({
    name,
    passed: r.status === 200 && r.requestId != null && rowFound && tagsOk,
    detail: `status=${r.status}, request_id=${r.requestId}, row_found=${rowFound}, tags_ok=${tagsOk}`,
  });
}

async function scenarioPlanReservation(
  databaseUrl: string,
  projectId: string,
  userId: string
): Promise<void> {
  const name =
    "E1. concurrent burst > Free plan daily cap → some get plan_limit_exceeded (PG)";
  // Same trick as scenario B — keep the upstream open so plan
  // reservations actually overlap.
  setMockMode({ kind: "ok_slow", delayMs: 200 });
  // Clear stale reservations from previous scenarios.
  await clearBudgetAndPlanReservations(databaseUrl, projectId, userId);
  // No explicit project budget — plan-tier daily cap should fire.
  // Free tier's daily cap is small (see plans.ts), so a burst of
  // requests with non-trivial estimated cost should bump into it.
  // We use a model with a high estimate to guarantee gating.
  const inflight: Promise<{ status: number; json: unknown }>[] = [];
  for (let i = 0; i < 30; i++) {
    inflight.push(
      chatRequest({
        model: "gpt-4o", // Higher-priced model → bigger per-request reservation.
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: `pg plan burst probe ${i} ${Math.random()}`.repeat(40),
          },
        ],
      })
    );
  }
  const all = await Promise.all(inflight);
  const planBlockedCount = all.filter(
    (r) =>
      r.status === 402 &&
      JSON.stringify(r.json).includes("plan_limit_exceeded")
  ).length;
  const sql = dbConn(databaseUrl.split("/").pop()!);
  let pending = 0;
  try {
    const p = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM plan_reservations
      WHERE user_id = ${userId} AND status = 'pending'
    `;
    pending = p[0]!.total;
  } finally {
    await sql.end();
  }
  await clearBudgetAndPlanReservations(databaseUrl, projectId, userId);
  results.push({
    name,
    passed: planBlockedCount > 0 && pending === 0,
    detail: `requests=${all.length}, plan_blocked=${planBlockedCount}, leftover_pending_plan=${pending}`,
  });
}

async function scenarioUnknownPriceFallback(
  databaseUrl: string,
  projectId: string,
  userId: string
): Promise<void> {
  const name =
    "E2. unknown-price model → reservation > 0 (was: silently 0) + reservation_basis tag (PG)";
  setMockMode({ kind: "ok" });
  await clearBudgetAndPlanReservations(databaseUrl, projectId, userId);

  // A model with a real provider regex match (`gpt-` → openai) but
  // not in our pricing table forces the family_max fallback. Without
  // the fix this would be a 0-cost reservation and the budget gate
  // would silently pass; with the fix the reservation pre-deducts
  // the family worst case * 1.5 safety multiplier.
  const r = await chatRequest({
    model: "gpt-totally-fake-2099",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: "pg unknown price probe " + Math.random(),
      },
    ],
  });

  let basisTag: string | null = null;
  if (r.requestId) {
    const sql = dbConn(databaseUrl.split("/").pop()!);
    try {
      const rows = await sql<{ tags: Record<string, string> }[]>`
        SELECT tags FROM requests WHERE id = ${r.requestId} LIMIT 1
      `;
      basisTag = rows[0]?.tags?.reservation_basis ?? null;
    } finally {
      await sql.end();
    }
  }
  results.push({
    name,
    // Acceptable outcomes:
    //   - 200 with reservation_basis=family_max  (request went through but
    //     was metered with the fallback estimate) — the EXPECTED happy path
    //   - 502 (mock returned 200, but upstream model name caused upstream
    //     downstream issue — unlikely in mock)
    // The KEY assertion: the basis tag must show family_max, proving the
    // reservation didn't silently use 0.
    passed: basisTag === "family_max",
    detail: `status=${r.status}, request_id=${r.requestId}, reservation_basis=${basisTag}`,
  });
}

async function main(): Promise<void> {
  startMockUpstream();
  let dbName = "";
  let gateway: Subprocess | null = null;
  let exitCode = 0;
  try {
    dbName = await createTempDatabase();
    const databaseUrl = databaseUrlFor(dbName);
    gateway = startGateway(databaseUrl);
    await waitForGateway();
    console.log("[e2e-pg] gateway ready");
    const fx = await seedFixtures(databaseUrl);
    console.log(
      `[e2e-pg] fixtures: project=${fx.projectId} user=${fx.userId} key_id=${fx.apiKeyId}`
    );

    await scenarioPersistentUpstream5xx();
    await scenarioRecoverableRetrySucceeds();
    await scenarioBudgetReservation(databaseUrl, fx.projectId, fx.userId);
    await scenarioLoopDetector(databaseUrl, fx.projectId);
    await scenarioOpenclawAttribution(databaseUrl);
    await scenarioPlanReservation(databaseUrl, fx.projectId, fx.userId);
    await scenarioUnknownPriceFallback(databaseUrl, fx.projectId, fx.userId);
  } catch (err) {
    console.error("[e2e-pg] aborted:", err);
    exitCode = 1;
  } finally {
    if (mockServer) mockServer.stop(true);
    if (gateway) {
      gateway.kill("SIGTERM");
      await gateway.exited.catch(() => {});
    }
    if (dbName) {
      await dropTempDatabase(dbName);
    }
  }

  let failed = 0;
  console.log("\n=== e2e Postgres verification results ===");
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    console.log(`${tag}  ${r.name}`);
    console.log(`      ${r.detail}`);
    if (!r.passed) failed++;
  }
  if (failed > 0 || exitCode !== 0) {
    console.error(`\n${failed} scenario(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Postgres e2e scenarios passed.");
}

await main();
