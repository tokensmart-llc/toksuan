/**
 * SQLite driver shim — end-to-end coverage.
 *
 * These tests boot the shim against an in-memory SQLite (no FS, no
 * Postgres docker), apply the SQLite-flavored migrations, and
 * exercise the representative query patterns the gateway makes:
 *   - findApiKey-shaped lookup with LEFT JOIN + sha256 hash + plaintext
 *   - insertRequest-shaped INSERT with JSONB-equivalent and RETURNING
 *   - getActiveBudgets / getRoutingRules SELECT with WHERE enabled = TRUE
 *   - sql.begin transaction commit + rollback semantics
 *   - sql.unsafe multi-statement migration script
 *   - ON CONFLICT DO NOTHING / DO UPDATE
 *
 * The goal is to catch translation bugs (PG INTERVAL, NOW(), DATE_TRUNC,
 * ::bigint casts, JSONB column DDL, gen_random_uuid() function) without
 * needing a real Bun:sqlite binding to be production-grade.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildSql, detectBackend } from "../src/sql-driver";

const SQLITE_MIGRATIONS_DIR = path.resolve(
  import.meta.dir,
  "../../../migrations-sqlite"
);
const SQLITE_MIGRATIONS = readdirSync(SQLITE_MIGRATIONS_DIR)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort((a, b) => a.localeCompare(b, "en"))
  .map((f) => readFileSync(path.join(SQLITE_MIGRATIONS_DIR, f), "utf-8"));

describe("detectBackend", () => {
  test("postgres URLs route to postgres", () => {
    expect(detectBackend("postgres://u:p@h/db")).toBe("postgres");
    expect(detectBackend("postgresql://u:p@h/db")).toBe("postgres");
  });
  test("sqlite URLs route to sqlite", () => {
    expect(detectBackend("sqlite:./foo.db")).toBe("sqlite");
    expect(detectBackend("sqlite:///abs/foo.db")).toBe("sqlite");
    expect(detectBackend(":memory:")).toBe("sqlite");
  });
  test("empty / unrecognised defaults to postgres", () => {
    expect(detectBackend("")).toBe("postgres");
  });
});

describe("SQLite shim — schema bootstrap", () => {
  let sql: ReturnType<typeof buildSql>;

  beforeAll(async () => {
    sql = buildSql(":memory:");
    for (const body of SQLITE_MIGRATIONS) {
      await sql.unsafe(body);
    }
  });

  afterAll(async () => {
    await (sql as unknown as { end: () => Promise<void> }).end();
  });

  test("seed default project + api key are present", async () => {
    const projects = await sql`SELECT id, name FROM projects`;
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects.some((p: { name: string }) => p.name === "default")).toBe(
      true
    );

    const keys = await sql`SELECT key, name FROM api_keys`;
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(
      keys.some((k: { key: string }) => k.key === "tokensmart-dev-key")
    ).toBe(true);
  });

  test("findApiKey-shaped query with LEFT JOIN works", async () => {
    const rows = await sql<
      Array<{ id: string; project_id: string; project_user_id: string | null }>
    >`
      SELECT k.id, k.project_id, p.user_id AS project_user_id
        FROM api_keys k
        LEFT JOIN projects p ON p.id = k.project_id
       WHERE k.key = ${"tokensmart-dev-key"}
       LIMIT 1
    `;
    expect(rows[0]?.project_id).toBe(
      "00000000-0000-0000-0000-000000000001"
    );
    expect(rows[0]?.project_user_id).toBeNull();
  });

  test("INSERT into requests with JSON-shaped column round-trips", async () => {
    const projectId = "00000000-0000-0000-0000-000000000001";
    const tags = (sql as unknown as { json: (v: unknown) => unknown }).json({
      feature: "test",
    });
    const reqBody = (sql as unknown as { json: (v: unknown) => unknown }).json({
      model: "gpt-4o",
      messages: [],
    });
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO requests (
        project_id, api_key_id, provider, model,
        input_tokens, output_tokens, cost_micro_cents,
        latency_ms, status, request_body, tags
      ) VALUES (
        ${projectId}, NULL, ${"openai"}, ${"gpt-4o"},
        100, 50, 1500,
        42, ${"success"}, ${reqBody}, ${tags}
      )
      RETURNING id
    `;
    expect(rows[0]?.id).toBeTruthy();

    // Verify tags roundtripped as JSON text + can be selected back.
    const fetched = await sql<Array<{ tags: string; status: string }>>`
      SELECT tags, status FROM requests WHERE id = ${rows[0]!.id}
    `;
    expect(fetched[0]?.status).toBe("success");
    expect(JSON.parse(fetched[0]!.tags)).toEqual({ feature: "test" });
  });

  test("getActiveBudgets-shaped SELECT with boolean filter", async () => {
    const projectId = "00000000-0000-0000-0000-000000000001";
    await sql`
      INSERT INTO budgets (project_id, period, limit_micro_cents, enabled)
      VALUES (${projectId}, ${"daily"}, ${50000}, ${true})
      ON CONFLICT (project_id, period) DO UPDATE SET enabled = excluded.enabled
    `;
    const enabled = await sql<Array<{ period: string }>>`
      SELECT period FROM budgets
       WHERE project_id = ${projectId} AND enabled = TRUE
    `;
    expect(enabled.some((b) => b.period === "daily")).toBe(true);
  });

  test("rolling-24h spend with NOW() - INTERVAL translation", async () => {
    const projectId = "00000000-0000-0000-0000-000000000001";
    const rows = await sql<Array<{ total: string | number | null }>>`
      SELECT COALESCE(SUM(cost_micro_cents), 0)::bigint AS total
        FROM requests
       WHERE project_id = ${projectId}
         AND status = 'success'
         AND created_at > NOW() - INTERVAL '24 hours'
    `;
    expect(Number(rows[0]?.total ?? 0)).toBeGreaterThanOrEqual(1500);
  });

  test("DATE_TRUNC('day', NOW()) translation", async () => {
    const projectId = "00000000-0000-0000-0000-000000000001";
    const rows = await sql<Array<{ total: string | number | null }>>`
      SELECT COALESCE(SUM(cost_micro_cents), 0)::bigint AS total
        FROM requests
       WHERE project_id = ${projectId}
         AND status = 'success'
         AND created_at >= DATE_TRUNC('day', NOW())
    `;
    expect(Number(rows[0]?.total ?? 0)).toBeGreaterThanOrEqual(1500);
  });

  test("sql.begin commits on success", async () => {
    const projectId = "00000000-0000-0000-0000-000000000001";
    await (
      sql as unknown as {
        begin: <T>(fn: (tx: typeof sql) => Promise<T>) => Promise<T>;
      }
    ).begin(async (tx) => {
      await tx`INSERT INTO routing_rules (project_id, threshold, from_pattern, to_model)
               VALUES (${projectId}, 0.3, ${"^gpt-4o$"}, ${"gpt-4o-mini"})`;
    });
    const rules = await sql`
      SELECT to_model FROM routing_rules WHERE from_pattern = ${"^gpt-4o$"}
    `;
    expect(rules.length).toBe(1);
  });

  test("sql.begin rolls back on throw", async () => {
    const projectId = "00000000-0000-0000-0000-000000000001";
    let thrown = false;
    try {
      await (
        sql as unknown as {
          begin: <T>(fn: (tx: typeof sql) => Promise<T>) => Promise<T>;
        }
      ).begin(async (tx) => {
        await tx`INSERT INTO routing_rules (project_id, threshold, from_pattern, to_model)
                 VALUES (${projectId}, 0.5, ${"^should-rollback$"}, ${"x"})`;
        throw new Error("boom");
      });
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
    const rules = await sql`
      SELECT to_model FROM routing_rules WHERE from_pattern = ${"^should-rollback$"}
    `;
    expect(rules.length).toBe(0);
  });

  test("identifier interpolation via sql(name)", async () => {
    const tableRef = (sql as unknown as (n: string) => unknown)("projects");
    const rows = await sql`SELECT COUNT(*)::int AS c FROM ${tableRef}`;
    expect(Number((rows[0] as { c: number }).c)).toBeGreaterThanOrEqual(1);
  });

  test("schema parity: api_keys.expires_at exists (was missing → broke auth)", async () => {
    // migrations/014 added this column on Postgres. The SQLite parallel
    // (migrations-sqlite/004) was missing for ages — every SQLite-mode
    // gateway returned 500 on auth because findApiKey() filters on
    // `(k.expires_at IS NULL OR k.expires_at > NOW())`.
    const cols = await sql<Array<{ name: string }>>`
      SELECT name FROM pragma_table_info('api_keys')
    `;
    expect(cols.some((c) => c.name === "expires_at")).toBe(true);
  });

  test("schema parity: routing_rules.sample_rate exists (was missing → broke chat)", async () => {
    // migrations/020 added this column on Postgres. The SQLite parallel
    // (migrations-sqlite/005) was missing — every SQLite-mode chat that
    // hit getRoutingRules() returned 500 because the SELECT named a
    // column that didn't exist.
    const cols = await sql<Array<{ name: string }>>`
      SELECT name FROM pragma_table_info('routing_rules')
    `;
    expect(cols.some((c) => c.name === "sample_rate")).toBe(true);
  });

  test("Date params serialise to SQLite-compatible format (was: ISO with T+Z silently broke same-day budget queries)", async () => {
    // CURRENT_TIMESTAMP stores `YYYY-MM-DD HH:MM:SS`. JS Date.toISOString()
    // is `YYYY-MM-DDTHH:MM:SS.sssZ`. Lexicographic comparison ranks the
    // ISO form GREATER (T = 0x54 > space = 0x20), so a JS-Date cutoff
    // would have excluded every same-day row from `created_at >= ?`
    // queries — silently making today's spend always 0 in SQLite mode.
    const projectId = "00000000-0000-0000-0000-000000000001";
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todayRows = await sql<Array<{ total: number | null }>>`
      SELECT COALESCE(SUM(cost_micro_cents), 0) AS total
      FROM requests
      WHERE project_id = ${projectId}
        AND status = 'success'
        AND created_at >= ${startOfDay}
    `;
    // Earlier test inserted a successful row in this DB. With the bug
    // present, this would silently return 0. With the fix, we see that row.
    expect(Number(todayRows[0]?.total ?? 0)).toBeGreaterThan(0);
  });
});
