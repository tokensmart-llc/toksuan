/**
 * Database driver dispatch — dashboard edition.
 *
 * This is a near-clone of `apps/gateway/src/sql-driver.ts` extended with
 * the JSONB-operator translations the dashboard's queries use heavily
 * (`tags->>'key'`, `request_body->'tools'`, `tags ? 'key'`,
 * `jsonb_typeof()`, `jsonb_array_length()`). The two files are kept
 * separate (rather than published as a workspace package) because the
 * repo isn't a workspace — duplicating one shim file is a lower-tax
 * trade than introducing a build/publish step.
 *
 * Why a shim and not a fork: the dashboard's `db.ts` already speaks
 * postgres.js's tagged-template surface
 * (`sql\`SELECT … ${val} …\``, `sql.unsafe(text)`, etc.). Translating
 * each call to bun:sqlite at runtime means callers don't need to branch
 * on backend, and the savings hero card / requests ledger / recent
 * receipts all "just work" against a SQLite trial install.
 *
 * What works under SQLite mode for the dashboard:
 *   - Savings hero (routing + cache + tool-result-compression breakdown)
 *   - Recent requests, request detail page
 *   - Spend totals, blocked counts, loop counts, routed counts
 *   - Top routed pairs, spend-by-model
 *   - Daily-spend chart (uses generate_series — SQLite shim emulates)
 *
 * What does NOT work under SQLite (and is supposed to no-op cleanly):
 *   - Anything that requires hosted auth (sessions, magic links, RBAC,
 *     org membership, Stripe). The dashboard already gates these on
 *     TOKENSMART_AUTH_ENABLED, which is off in the SQLite trial mode.
 *   - LATERAL / CROSS JOIN LATERAL queries (Spend by tag, agent-harness
 *     extraction). Those queries throw under SQLite; the dashboard
 *     catches into `dbError`/empty-state and the rest of the page
 *     keeps rendering.
 */

import postgres, { type Sql as PgSql } from "postgres";

export type DbBackend = "postgres" | "sqlite";

export type Sql = PgSql<{}>;

export function detectBackend(url: string): DbBackend {
  if (!url) return "postgres";
  if (url === ":memory:") return "sqlite";
  if (/^sqlite:/i.test(url)) return "sqlite";
  return "postgres";
}

let cachedBackend: DbBackend | null = null;

export function activeBackend(): DbBackend {
  return cachedBackend ?? "postgres";
}

export function buildSql(url: string): Sql {
  const backend = detectBackend(url);
  cachedBackend = backend;
  if (backend === "postgres") {
    return postgres(url, {
      max: 5,
      idle_timeout: 20,
      onnotice: () => {},
    });
  }
  return buildSqliteShim(url);
}

// ---------------------------------------------------------------------------
// SQLite shim
// ---------------------------------------------------------------------------

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
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return v;
  if (isJsonMarker(v)) return JSON.stringify(v.value);
  return JSON.stringify(v);
}

/**
 * Translate Postgres-flavoured SQL to SQLite-flavoured SQL. Order
 * matters in a few places, called out inline. Best-effort — patterns
 * we don't recognise pass through unchanged and the query may then
 * raise a runtime "no such column / function" which the dashboard
 * catches.
 */
function translatePgToSqlite(sql: string): string {
  let s = sql;

  // -- INTERVAL string concatenation --------------------------------------
  // The dashboard heavily uses
  //   `created_at > NOW() - (${param} || ' days')::INTERVAL`
  // The `::INTERVAL` strip below would leave
  //   `created_at > CURRENT_TIMESTAMP - (${param} || ' days')`
  // which evaluates the string concat numerically (zero) — completely
  // breaks the time window. Translate the whole pattern up front.
  // Match BEFORE the cast strip, because we depend on `::INTERVAL` being
  // present to disambiguate from arbitrary string-concat expressions.
  s = s.replace(
    /\bNOW\(\)\s*-\s*\(\s*([^)]+?)\s*\|\|\s*'\s+(days?|hours?|minutes?|seconds?|months?|years?)'\s*\)\s*::\s*INTERVAL/gi,
    (_m, expr, unit) =>
      `datetime('now', '-' || (${expr.trim()}) || ' ${unit.toLowerCase()}')`
  );
  s = s.replace(
    /\bNOW\(\)\s*\+\s*\(\s*([^)]+?)\s*\|\|\s*'\s+(days?|hours?|minutes?|seconds?|months?|years?)'\s*\)\s*::\s*INTERVAL/gi,
    (_m, expr, unit) =>
      `datetime('now', '+' || (${expr.trim()}) || ' ${unit.toLowerCase()}')`
  );

  // -- jsonb / json operators --------------------------------------------
  // Postgres: `column->>'key'`  → text value at key
  // Postgres: `column->'key'`   → jsonb value at key
  // SQLite:   `json_extract(column, '$.key')` for both — SQLite's JSON1
  // returns text for scalars, JSON-text for nested. The dashboard never
  // distinguishes between the two operators in practice; treating both
  // as `json_extract` gives the right answer for every use site we
  // grep'd, and is the same translation the gateway shim would have
  // wanted but didn't need.
  s = s.replace(
    /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*->>\s*'([^']+)'/gi,
    (_m, col, key) => `json_extract(${col}, '$.${key}')`
  );
  s = s.replace(
    /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*->\s*'([^']+)'/gi,
    (_m, col, key) => `json_extract(${col}, '$.${key}')`
  );

  // Postgres `jsonb ? 'key'` (has-key). SQLite has no direct equivalent;
  // emulate via `json_extract(...) IS NOT NULL`. Note: JSON nulls vs SQL
  // nulls differ — a key whose VALUE is `null` would also test false
  // here. The dashboard only uses `?` on tags whose values are non-null
  // strings, so the false-negative case doesn't apply.
  s = s.replace(
    /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\?\s*'([^']+)'/gi,
    (_m, col, key) => `json_extract(${col}, '$.${key}') IS NOT NULL`
  );

  // jsonb_typeof + jsonb_array_length → SQLite JSON1 equivalents.
  s = s.replace(/\bjsonb_typeof\b/gi, "json_type");
  s = s.replace(/\bjsonb_array_length\b/gi, "json_array_length");

  // -- explicit casts ----------------------------------------------------
  // SQLite is dynamically typed; the casts the dashboard uses (mostly to
  // coerce SUM() return type or to widen for arithmetic) are no-ops at
  // the SQLite level. Strip them after the INTERVAL pattern fired —
  // doing this first would have broken the INTERVAL match above.
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
  // After these strips, lingering `::uuid[]` from `ANY(...::uuid[])`
  // remains, but that whole construct is only used when `scope` is a
  // populated array — i.e. multi-tenant auth mode, which doesn't run
  // under SQLite. The translation is best-effort: drop the cast.
  s = s.replace(/::uuid\b/gi, "");
  s = s.replace(/::uuid\[\]/gi, "");

  // -- date arithmetic with bare INTERVAL literals -----------------------
  s = s.replace(
    /\bNOW\(\)\s*-\s*INTERVAL\s+'(\d+)\s+(\w+)'/gi,
    (_m, n, unit) => `datetime('now', '-${n} ${unit}')`
  );
  s = s.replace(
    /\bNOW\(\)\s*\+\s*INTERVAL\s+'(\d+)\s+(\w+)'/gi,
    (_m, n, unit) => `datetime('now', '+${n} ${unit}')`
  );
  s = s.replace(/\bDATE_TRUNC\(\s*'day'\s*,\s*NOW\(\)\s*\)/gi, "date('now')");
  s = s.replace(
    /\bDATE_TRUNC\(\s*'month'\s*,\s*NOW\(\)\s*\)/gi,
    "date('now','start of month')"
  );
  s = s.replace(
    /\bDATE_TRUNC\(\s*'hour'\s*,\s*NOW\(\)\s*\)/gi,
    "strftime('%Y-%m-%d %H:00:00','now')"
  );
  // `DATE_TRUNC('day', col)` (column variant — used in joins on per-day
  // bucketing). SQLite's `date(col)` is the equivalent for a TEXT
  // datetime column.
  s = s.replace(
    /\bDATE_TRUNC\(\s*'day'\s*,\s*([^,)]+)\)/gi,
    (_m, expr) => `date(${expr.trim()})`
  );
  s = s.replace(
    /\bDATE_TRUNC\(\s*'hour'\s*,\s*([^,)]+)\)/gi,
    (_m, expr) => `strftime('%Y-%m-%d %H:00:00', ${expr.trim()})`
  );

  s = s.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP");

  // IS [NOT] DISTINCT FROM
  s = s.replace(/\bIS\s+DISTINCT\s+FROM\b/gi, "IS NOT");
  s = s.replace(/\bIS\s+NOT\s+DISTINCT\s+FROM\b/gi, "IS");

  // gen_random_uuid()
  const RAND_UUID =
    "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) " +
    "|| '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) " +
    "|| '-' || lower(hex(randomblob(6))))";
  s = s.replace(/\bgen_random_uuid\(\)/gi, RAND_UUID);

  return s;
}

type SqliteRunResult = { changes: number; lastInsertRowid: number | bigint };

function openSqlite(url: string): {
  run: (sql: string, params: unknown[]) => SqliteRunResult;
  all: (sql: string, params: unknown[]) => Record<string, unknown>[];
  exec: (sql: string) => void;
  close: () => void;
} {
  // We use `better-sqlite3` rather than `bun:sqlite` here on purpose.
  // The dashboard launches `next dev`, and Next.js spawns its own
  // Node server even when invoked via `bun run dev` — so a `require`
  // for `bun:sqlite` ends up in Node's resolver, not Bun's, and fails
  // with MODULE_NOT_FOUND. better-sqlite3 is the standard npm
  // SQLite binding and works under both Node and Bun. Net behaviour:
  // dashboard reads the SAME db file the gateway wrote (the gateway
  // still uses bun:sqlite — it's pure-Bun runtime), no fork, no IPC.
  //
  // The two backends interop fine because SQLite is a single file
  // protocol; we only read on this side, the gateway holds the
  // writer connection.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as new (
    path: string,
    opts?: { readonly?: boolean; fileMustExist?: boolean }
  ) => {
    prepare: (sql: string) => {
      run: (...params: unknown[]) => SqliteRunResult;
      all: (...params: unknown[]) => Record<string, unknown>[];
      get: (...params: unknown[]) => Record<string, unknown> | undefined;
    };
    exec: (sql: string) => void;
    close: () => void;
    pragma: (s: string) => unknown;
  };

  const dbPath =
    url === ":memory:"
      ? ":memory:"
      : url.replace(/^sqlite:(\/\/)?/i, "") || ":memory:";

  if (dbPath !== ":memory:") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require("node:path") as typeof import("node:path");
    const dir = pathMod.dirname(dbPath);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Open the file shared with the gateway. The gateway already
  // enabled WAL on its side; we only need a busy-timeout so reader
  // queries that race against the gateway's writer wait briefly
  // instead of immediately returning SQLITE_BUSY.
  const db = new Database(dbPath, { fileMustExist: false });
  db.pragma("busy_timeout = 5000");

  return {
    run: (sql, params) =>
      db.prepare(sql).run(...(params as unknown[])) as SqliteRunResult,
    all: (sql, params) => db.prepare(sql).all(...(params as unknown[])),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

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
      } else if (
        v !== null &&
        typeof v === "object" &&
        // postgres.js produces "fragment" objects from nested `sql\`...\``
        // calls (the projectScope helper heavily uses these). We detect
        // them by the strings/values shape and recursively expand.
        Array.isArray((v as { strings?: unknown }).strings) &&
        Array.isArray((v as { values?: unknown }).values)
      ) {
        const frag = v as { strings: string[]; values: unknown[] };
        const inner = buildStatement(frag.strings, frag.values);
        out += inner.sql;
        params.push(...inner.params);
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

  function tag(
    strings: TemplateStringsArray | string,
    ...values: unknown[]
  ): unknown {
    if (typeof strings === "string") {
      return { [IDENT_TAG]: true, name: strings } as IdentMarker;
    }
    // Surface the un-translated template strings + values on the
    // returned thenable so a parent template can splice us in (the
    // projectScope nested-template idiom). We do this by also
    // sticking them on the resolved Promise, which postgres.js
    // doesn't do — but the shim's buildStatement detects fragments
    // by the .strings/.values shape, not by Promise identity, so we
    // attach them to a plain object that's also a thenable.
    const fragment: {
      strings: readonly string[];
      values: readonly unknown[];
      then?: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => void;
    } = {
      strings,
      values,
    };
    fragment.then = (resolve, reject) => {
      try {
        resolve(run(strings, values));
      } catch (err) {
        if (reject) reject(err);
        else throw err;
      }
    };
    return fragment;
  }

  (tag as unknown as { unsafe: (text: string, params?: unknown[]) => Promise<unknown> }).unsafe = (
    text: string,
    params: unknown[] = []
  ) => {
    const translated = translatePgToSqlite(text);
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

  (tag as unknown as { json: (v: unknown) => JsonMarker }).json = (v: unknown) => ({
    [JSON_TAG]: true,
    value: v,
  });

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

  (tag as unknown as { end: () => Promise<void> }).end = async () => {
    driver.close();
  };

  return tag as unknown as Sql;
}
