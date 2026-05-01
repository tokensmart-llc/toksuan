/**
 * Database driver dispatch (v0.3.x).
 *
 * Default and recommended for production: PostgreSQL via `postgres.js`.
 * Selected when DATABASE_URL starts with `postgres://`, `postgresql://`,
 * or is unset (legacy default).
 *
 * Experimental "single-binary trial" backend: SQLite via Bun's built-in
 * `bun:sqlite`. Selected when DATABASE_URL starts with `sqlite://` or
 * `sqlite:` or is the literal string `:memory:`. Examples:
 *
 *     DATABASE_URL=sqlite:./data/tokensmart.db
 *     DATABASE_URL=:memory:
 *
 * Why a shim and not a fork: the gateway's queries already use the
 * postgres.js tagged-template surface (`sql\`SELECT … ${val} …\``,
 * `sql.unsafe(text)`, `sql.begin(fn)`, `sql.json(x)`). The shim
 * translates each of those to bun:sqlite at call time so callers don't
 * need to branch on the backend.
 *
 * What works under SQLite mode:
 *   - Health endpoint, plan-free single-tenant chat completions
 *   - Per-project budgets, routing rules, alert rules, requests ledger
 *   - Loop detection, baseline policy routing, cache_control injection,
 *     OTel export, x-ts-tag attribution
 *   - The new x-ts-template substitution path (templates land in SQLite
 *     too via the parallel migrations-sqlite/ schema)
 *
 * What does NOT work under SQLite mode (deliberate — these are
 * multi-tenant features and SQLite is a single-binary evaluation
 * backend):
 *   - Hosted auth, sessions, magic links, organizations, RBAC, invites
 *   - BYO encrypted provider keys (KMS or env-master-key crypto)
 *   - Plan-tier daily / monthly request caps
 *   - Semantic cache (embedding similarity uses pg-specific SQL)
 *   - Stripe webhook bookkeeping, referral credits, audit log
 *   - Auto cost-anomaly monitor (z-score query uses date_trunc + lateral)
 *
 * The gateway boots in `lite` mode automatically when the SQLite path is
 * selected — these subsystems no-op cleanly. See `apps/gateway/src/index.ts`
 * for the gating.
 */

import postgres, { type Sql as PgSql } from "postgres";

export type DbBackend = "postgres" | "sqlite";

/**
 * Detect the backend from the URL. Defaults to Postgres for any
 * unrecognised scheme so an empty URL still produces a useful error
 * (postgres.js will reject it with its own message).
 */
export function detectBackend(url: string): DbBackend {
  if (!url) return "postgres";
  if (url === ":memory:") return "sqlite";
  if (/^sqlite:/i.test(url)) return "sqlite";
  return "postgres";
}

/**
 * Postgres.js's `Sql` is the lowest-common-denominator type that all
 * gateway DB callers rely on. The SQLite shim claims to satisfy this
 * type via a structural cast — at runtime its surface is a strict subset
 * (we only implement what the gateway actually calls).
 */
export type Sql = PgSql<{}>;

let cachedBackend: DbBackend | null = null;

/**
 * Returns the active backend selected at boot. Useful for feature gating
 * (e.g. semantic cache, BYO encrypted keys) that doesn't make sense
 * outside of the postgres path.
 */
export function activeBackend(): DbBackend {
  return cachedBackend ?? "postgres";
}

/**
 * Build the `sql` driver for the gateway. Called once from `db.ts`.
 */
export function buildSql(url: string): Sql {
  const backend = detectBackend(url);
  cachedBackend = backend;
  if (backend === "postgres") {
    return postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return buildSqliteShim(url);
}

// ---------------------------------------------------------------------------
// SQLite shim
// ---------------------------------------------------------------------------

/**
 * The shim emulates postgres.js's tagged-template API. Translation rules
 * applied to every interpolated SQL literal:
 *
 *   `NOW()`                              → CURRENT_TIMESTAMP
 *   `NOW() - INTERVAL 'N unit'`          → datetime('now', '-N unit')
 *   `DATE_TRUNC('day', NOW())`           → date('now')
 *   `DATE_TRUNC('month', NOW())`         → date('now', 'start of month')
 *   `gen_random_uuid()`                  → registered SQLite function
 *   `::bigint` / `::int` / `::text`      → stripped (SQLite is dynamic)
 *   `IS DISTINCT FROM`                   → IS NOT
 *   `RETURNING *`                        → kept (SQLite 3.35+)
 *   `JSONB` (in DDL only)                → TEXT
 *   `TIMESTAMPTZ` / `TIMESTAMP` in DDL  → TEXT
 *   `UUID` in DDL                        → TEXT
 *   `BOOLEAN` in DDL                     → INTEGER
 *
 * Parameter binding: postgres.js uses `${value}` interpolation that
 * becomes `$1`/`$2` placeholders; we rewrite to SQLite's `?`. Booleans
 * are serialised to 0/1; objects are JSON-stringified; nulls passed
 * through.
 */

const JSON_TAG = Symbol("ts.json");
const IDENT_TAG = Symbol("ts.identifier");

interface JsonMarker {
  [JSON_TAG]: true;
  value: unknown;
}
interface IdentMarker {
  [IDENT_TAG]: true;
  name: string;
}

function isJsonMarker(v: unknown): v is JsonMarker {
  return Boolean(v && typeof v === "object" && (v as JsonMarker)[JSON_TAG]);
}
function isIdentMarker(v: unknown): v is IdentMarker {
  return Boolean(v && typeof v === "object" && (v as IdentMarker)[IDENT_TAG]);
}

/**
 * Format a JS Date as the literal text SQLite produces from
 * `CURRENT_TIMESTAMP`: "YYYY-MM-DD HH:MM:SS" (UTC, no T, no fractional
 * seconds, no Z). Lexicographic comparison against rows whose
 * `created_at` was populated by `DEFAULT CURRENT_TIMESTAMP` then gives
 * the right answer — `Date.toISOString()`'s "T" (0x54) collates AFTER
 * the space (0x20) used by CURRENT_TIMESTAMP, which would have made
 * `created_at >= ${jsCutoff}` exclude every row stored today even when
 * the cutoff is start-of-day.
 */
function serialiseDateForSqlite(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function serialiseParam(v: unknown): string | number | null | bigint | Buffer {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "string") return v;
  if (v instanceof Date) return serialiseDateForSqlite(v);
  if (Buffer.isBuffer(v)) return v;
  if (isJsonMarker(v)) return JSON.stringify(v.value);
  return JSON.stringify(v);
}

function translatePgToSqlite(sql: string): string {
  let s = sql;

  // Strip explicit casts — SQLite is dynamic. Keep order: longest first.
  s = s.replace(/::bigint\b/gi, "");
  s = s.replace(/::int\b/gi, "");
  s = s.replace(/::integer\b/gi, "");
  s = s.replace(/::text\b/gi, "");
  s = s.replace(/::real\b/gi, "");
  s = s.replace(/::numeric\b/gi, "");
  s = s.replace(/::jsonb\b/gi, "");
  s = s.replace(/::json\b/gi, "");
  s = s.replace(/::timestamptz\b/gi, "");
  s = s.replace(/::timestamp\b/gi, "");

  // Date arithmetic. Order matters: handle the offset patterns BEFORE
  // the bare NOW() rewrite.
  s = s.replace(
    /\bNOW\(\)\s*-\s*INTERVAL\s+'(\d+)\s+(\w+)'/gi,
    (_m, n, unit) => `datetime('now', '-${n} ${unit}')`
  );
  s = s.replace(
    /\bNOW\(\)\s*\+\s*INTERVAL\s+'(\d+)\s+(\w+)'/gi,
    (_m, n, unit) => `datetime('now', '+${n} ${unit}')`
  );
  s = s.replace(
    /\bDATE_TRUNC\(\s*'day'\s*,\s*NOW\(\)\s*\)/gi,
    "date('now')"
  );
  s = s.replace(
    /\bDATE_TRUNC\(\s*'month'\s*,\s*NOW\(\)\s*\)/gi,
    "date('now','start of month')"
  );
  s = s.replace(
    /\bDATE_TRUNC\(\s*'hour'\s*,\s*NOW\(\)\s*\)/gi,
    "strftime('%Y-%m-%d %H:00:00','now')"
  );
  s = s.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP");

  // IS DISTINCT FROM is just IS NOT in SQLite
  s = s.replace(/\bIS\s+DISTINCT\s+FROM\b/gi, "IS NOT");
  s = s.replace(/\bIS\s+NOT\s+DISTINCT\s+FROM\b/gi, "IS");

  // gen_random_uuid() — synthesise a v4-shaped uuid using SQLite primitives.
  // bun:sqlite doesn't expose user-defined-function registration, so we
  // expand the call into pure-SQL randomblob composition. Note: this does
  // NOT set the v4 version + variant bits (would require bitwise ops on
  // hex substrings — clutters the inline expression and isn't needed for
  // correctness of equality-keyed columns); the result is hex-uniform.
  const RAND_UUID =
    "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) " +
    "|| '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) " +
    "|| '-' || lower(hex(randomblob(6))))";
  s = s.replace(/\bgen_random_uuid\(\)/gi, RAND_UUID);

  return s;
}

type SqliteRunResult = { changes: number; lastInsertRowid: number | bigint };

/**
 * Lazily load `bun:sqlite` so the postgres-only build doesn't pull in
 * Bun-specific types at compile time.
 */
function openSqlite(url: string): {
  run: (sql: string, params: unknown[]) => SqliteRunResult;
  all: (sql: string, params: unknown[]) => Record<string, unknown>[];
  exec: (sql: string) => void;
  close: () => void;
} {
  // bun:sqlite is part of the Bun runtime — no npm dep needed.
  // Resolved dynamically so plain Node typecheck doesn't try to find it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("bun:sqlite") as {
    Database: new (path: string, opts?: { create?: boolean }) => {
      query: (sql: string) => {
        run: (...params: unknown[]) => SqliteRunResult;
        all: (...params: unknown[]) => Record<string, unknown>[];
      };
      exec: (sql: string) => void;
      close: () => void;
    };
  };

  const dbPath =
    url === ":memory:"
      ? ":memory:"
      : url.replace(/^sqlite:(\/\/)?/i, "") || ":memory:";

  // Make sure the parent directory exists. SQLite errors out with
  // SQLITE_CANTOPEN if any directory in the path is missing — common
  // footgun on a fresh `install.sh --sqlite` run that puts the file at
  // ./data/tokensmart.db before the data/ dir was created.
  if (dbPath !== ":memory:") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pathMod = require("node:path") as typeof import("node:path");
    const dir = pathMod.dirname(dbPath);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new mod.Database(dbPath, { create: true });
  // SQLite is permissive about types; encourage WAL for concurrent reads.
  // (WAL is incompatible with `:memory:` — silently skip.)
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  return {
    run: (sql, params) => db.query(sql).run(...(params as unknown[])),
    all: (sql, params) => db.query(sql).all(...(params as unknown[])),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

/**
 * Convert a tagged template's raw strings + values into a single SQL
 * statement with `?` placeholders, plus the params array for binding.
 */
function buildStatement(
  strings: readonly string[],
  values: readonly unknown[]
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i]!;
    if (i < values.length) {
      const v = values[i];
      if (isIdentMarker(v)) {
        out += `"${v.name.replace(/"/g, '""')}"`;
      } else {
        out += "?";
        params.push(serialiseParam(v));
      }
    }
  }
  return { sql: translatePgToSqlite(out), params };
}

const READ_RE = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)/i;

function buildSqliteShim(url: string): Sql {
  const driver = openSqlite(url);

  function run(strings: readonly string[], values: readonly unknown[]): unknown {
    const { sql, params } = buildStatement(strings, values);
    if (READ_RE.test(sql) || /RETURNING\b/i.test(sql)) {
      return driver.all(sql, params);
    }
    driver.run(sql, params);
    return [];
  }

  // The tagged-template entry. Returns a thenable so `await sql\`...\`` works.
  function tag(
    strings: TemplateStringsArray | string,
    ...values: unknown[]
  ): unknown {
    if (typeof strings === "string") {
      // Identifier shorthand: `sql("table_name")` produces a quoted ident
      // that other tagged-template calls splice in. Mirrors postgres.js.
      return { [IDENT_TAG]: true, name: strings } as IdentMarker;
    }
    const result = run(strings, values);
    return Promise.resolve(result);
  }

  // sql.unsafe(text, params?) — no template string, raw SQL.
  (tag as unknown as { unsafe: (text: string, params?: unknown[]) => Promise<unknown> }).unsafe = (
    text: string,
    params: unknown[] = []
  ) => {
    const translated = translatePgToSqlite(text);
    // Multi-statement scripts (migrations) are common via unsafe(). bun:sqlite's
    // exec() handles those; query().all() / .run() do NOT. Detect and route.
    if (params.length === 0 && /;\s*[\s\S]+?;/.test(translated)) {
      driver.exec(translated);
      return Promise.resolve([]);
    }
    if (READ_RE.test(translated) || /RETURNING\b/i.test(translated)) {
      return Promise.resolve(driver.all(translated, params));
    }
    driver.run(translated, params);
    return Promise.resolve([]);
  };

  // sql.json(x) — wrap a value so it's serialised as JSON when bound.
  (tag as unknown as { json: (v: unknown) => JsonMarker }).json = (v: unknown) => ({
    [JSON_TAG]: true,
    value: v,
  });

  // sql.begin(async (tx) => ...) — bun:sqlite has no first-class async
  // transactions; we synthesise one with BEGIN / COMMIT / ROLLBACK.
  (tag as unknown as {
    begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  }).begin = async <T,>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
    driver.exec("BEGIN");
    try {
      const out = await fn(tag as unknown as Sql);
      driver.exec("COMMIT");
      return out;
    } catch (err) {
      driver.exec("ROLLBACK");
      throw err;
    }
  };

  // sql.end() — best-effort close. Postgres.js exposes this; tests use it.
  (tag as unknown as { end: () => Promise<void> }).end = async () => {
    driver.close();
  };

  return tag as unknown as Sql;
}
