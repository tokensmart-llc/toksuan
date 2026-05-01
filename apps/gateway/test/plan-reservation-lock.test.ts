/**
 * Concurrency test for `reservePlanForRequest` — the failure mode the
 * advisory lock is there to prevent.
 *
 * Without per-user serialization (`pg_advisory_xact_lock(hashtext($1))`),
 * two concurrent reservations under READ COMMITTED both read the same
 * `pending sum`, both pass the limit check, both INSERT. Repeated at
 * scale this means a Free-tier user can quietly burn through 10x their
 * cap if their agent fires turns in parallel.
 *
 * This test:
 *   1. Stands up a temp Postgres database.
 *   2. Seeds a user + a project.
 *   3. Fires N parallel reservePlanForRequest() calls against a daily
 *      cap that admits exactly K of them.
 *   4. Asserts pending reservations end up at K (not N), and that the
 *      committed + reserved total never exceeds the cap.
 *
 * Auto-skips when local Postgres is unreachable so `bun test` stays
 * green on dev machines without docker compose up.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const PG_HOST = process.env.TOKENSMART_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = Number(process.env.TOKENSMART_TEST_PG_PORT ?? "5432");
const PG_USER = process.env.TOKENSMART_TEST_PG_USER ?? "tokensmart";
const PG_PASS = process.env.TOKENSMART_TEST_PG_PASSWORD ?? "tokensmart_dev";
const PG_ADMIN_DB =
  process.env.TOKENSMART_TEST_PG_ADMIN_DB ?? "tokensmart";
const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../../../migrations");

let tempDbName: string | null = null;
let pgReachable = false;
let dbApi: typeof import("../src/db") | null = null;
let sql: postgres.Sql<{}> | null = null;

const FIXTURE_USER_ID = "00000000-0000-0000-0000-00000000d000";
const FIXTURE_PROJECT_ID = "00000000-0000-0000-0000-00000000d100";

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

beforeAll(async () => {
  pgReachable = await isPostgresReachable();
  if (!pgReachable) {
    console.log(
      `[plan-lock] Postgres at ${PG_HOST}:${PG_PORT} not reachable — skipping. ` +
        `Run \`docker compose up -d postgres\` to enable.`
    );
    return;
  }
  // Create a hermetic temp DB so this test doesn't fight other tests.
  const name = `ts_lock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (!/^ts_lock_[a-z0-9_]+$/.test(name)) throw new Error("internal: bad name");
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
  tempDbName = name;

  const url = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${name}`;
  // The DATABASE_URL must be set before the gateway db.ts is imported
  // for the first time — its module-level `sql = postgres(url)` reads
  // env eagerly. The dynamic import below picks up the temp DB.
  process.env.DATABASE_URL = url;

  // Apply the canonical Postgres migrations directly. We don't go
  // through the gateway's migration runner because it logs ops audit
  // rows etc. that aren't needed here.
  sql = postgres(url, { max: 8 });
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const f of files) {
    const body = readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
    await sql.unsafe(body);
  }

  // Seed the row chain reservePlanForRequest needs (it joins requests
  // → projects → users to compute the rolling spend / count).
  await sql`
    INSERT INTO users (id, email, plan)
    VALUES (${FIXTURE_USER_ID}, 'plan-lock-test@tokensmart.test', 'free')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO projects (id, user_id, name)
    VALUES (${FIXTURE_PROJECT_ID}, ${FIXTURE_USER_ID}, 'plan-lock-test-project')
    ON CONFLICT (id) DO NOTHING
  `;

  dbApi = await import("../src/db");
  if (dbApi.dbBackend !== "postgres") {
    // In the full suite, another test may have imported src/db while
    // DATABASE_URL pointed at SQLite. The module-level backend is then
    // already fixed to sqlite, so reservePlanForRequest intentionally skips
    // the Postgres advisory lock this file is trying to test.
    console.log(
      `[plan-lock] db.ts already loaded with ${dbApi.dbBackend} backend — skipping. ` +
        `Run this file with DATABASE_URL pointing at Postgres to enable.`
    );
    pgReachable = false;
    return;
  }
});

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 1 });
    sql = null;
  }
  if (tempDbName) {
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
          WHERE datname = '${tempDbName}' AND pid <> pg_backend_pid()`
      );
      await adm.unsafe(`DROP DATABASE IF EXISTS "${tempDbName}"`);
    } catch (err) {
      console.warn(`[plan-lock] drop ${tempDbName} failed:`, err);
    } finally {
      await adm.end({ timeout: 1 });
    }
    tempDbName = null;
  }
});

describe("reservePlanForRequest concurrency", () => {
  test("N parallel reservations under a tight cap admit only floor(cap/amount), no overshoot", async () => {
    if (!pgReachable || !dbApi || !sql) {
      console.log("  → skipped (Postgres not reachable)");
      return;
    }
    // Per-request reservation amount in micro_cents. With a daily cap
    // of 5000 and amount 1000 → exactly 5 of 12 attempts should pass.
    const amount = 1000;
    const dailyCap = 5000;
    const expectedAdmitted = Math.floor(dailyCap / amount);

    // Reset per-test state. plan_reservations is the only table this
    // function writes; clearing it gives every test a clean baseline.
    // We pass `sql` (the temp-DB client) explicitly because the
    // module-level singleton inside src/db.ts was bound to whatever
    // DATABASE_URL the FIRST gateway-test file resolved at import
    // time — usually the dev DB, NOT our temp DB.
    await sql`DELETE FROM plan_reservations WHERE user_id = ${FIXTURE_USER_ID}`;

    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        dbApi!.reservePlanForRequest(
          FIXTURE_USER_ID,
          amount,
          dailyCap,
          Number.POSITIVE_INFINITY,
          sql!
        )
      )
    );
    const ok = attempts.filter((a) => a.ok).length;
    const denied = attempts.filter((a) => !a.ok).length;
    expect(ok).toBe(expectedAdmitted);
    expect(denied).toBe(12 - expectedAdmitted);

    // The pending row count in DB must match the admitted count —
    // proves no orphan reservations leaked from rejected attempts.
    const pending = await sql<Array<{ total: number }>>`
      SELECT COUNT(*)::int AS total FROM plan_reservations
      WHERE user_id = ${FIXTURE_USER_ID} AND status = 'pending'
    `;
    expect(pending[0]?.total).toBe(expectedAdmitted);

    // The total reserved in micro_cents must be <= the cap. This is
    // the actual safety property — without the lock you'd see
    // total_reserved > dailyCap.
    const reservedSum = await sql<Array<{ total: string }>>`
      SELECT COALESCE(SUM(amount_micro_cents), 0)::bigint AS total
      FROM plan_reservations
      WHERE user_id = ${FIXTURE_USER_ID}
        AND status = 'pending'
        AND expires_at > NOW()
    `;
    expect(Number(reservedSum[0]?.total ?? 0)).toBeLessThanOrEqual(dailyCap);
  });

  test("monthly request cap admits exactly the configured count under burst", async () => {
    if (!pgReachable || !dbApi || !sql) return;
    await sql`DELETE FROM plan_reservations WHERE user_id = ${FIXTURE_USER_ID}`;
    const monthlyCap = 4;
    // 10 parallel attempts under a 4-request monthly cap (and unlimited
    // spend so the daily dimension doesn't gate first) must admit
    // exactly 4 — proves the lock keeps the count check atomic too.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        dbApi!.reservePlanForRequest(
          FIXTURE_USER_ID,
          0,
          Number.POSITIVE_INFINITY,
          monthlyCap,
          sql!
        )
      )
    );
    const ok = attempts.filter((a) => a.ok).length;
    expect(ok).toBe(monthlyCap);
  });

  test("releasePlanReservations releases exactly the rows passed in", async () => {
    if (!pgReachable || !dbApi || !sql) return;
    await sql`DELETE FROM plan_reservations WHERE user_id = ${FIXTURE_USER_ID}`;
    const a = await dbApi.reservePlanForRequest(
      FIXTURE_USER_ID,
      100,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      sql
    );
    const b = await dbApi.reservePlanForRequest(
      FIXTURE_USER_ID,
      100,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      sql
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    await dbApi.releasePlanReservations(
      [a.reservation_id, b.reservation_id].filter(
        (x): x is string => x != null
      ),
      sql
    );
    const stillPending = await sql<Array<{ total: number }>>`
      SELECT COUNT(*)::int AS total FROM plan_reservations
      WHERE user_id = ${FIXTURE_USER_ID} AND status = 'pending'
    `;
    expect(stillPending[0]?.total).toBe(0);
  });
});
