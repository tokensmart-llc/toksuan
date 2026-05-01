/**
 * In-app SQL migration runner.
 *
 * Postgres' `docker-entrypoint-initdb.d` runs SQL files only on FIRST volume
 * init — every later container start is a no-op. That means any migration
 * added after a developer first ran `docker compose up -d` lives in the
 * filesystem but never reaches their DB. We've hit this twice now in the
 * span of two sprints; the right fix is making the gateway apply pending
 * migrations at boot, the way LiteLLM, Helicone, Supabase, and every other
 * mature OSS data-tool does.
 *
 * Algorithm:
 *
 *   1. Locate the migrations/ directory (supports dev + Docker layouts +
 *      operator override via TOKENSMART_MIGRATIONS_DIR).
 *   2. CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, …)
 *   3. List `migrations/*.sql` sorted lexicographically.
 *   4. For each NOT in `schema_migrations`:
 *        BEGIN;
 *        <run file contents>;
 *        INSERT INTO schema_migrations (filename, sha256, applied_at) VALUES (…);
 *        COMMIT;
 *   5. On any failure: ROLLBACK + crash the gateway with a clear error
 *      pointing at the failing file. Better than booting in a half-applied
 *      state.
 *
 * Bootstrap concern (existing dev DBs):
 *   - A DB that was init'd via docker-entrypoint-initdb.d at any past
 *     version has tables but no schema_migrations row.
 *   - Our migrations are all idempotent (IF NOT EXISTS / DO blocks), so
 *     re-running them on an existing DB is safe — they're no-ops.
 *   - First run with this module on a legacy DB will print `applied: NN
 *     ms` for each file and stamp them. Subsequent boots: instant.
 *
 * Disabling:
 *   - Set TOKENSMART_AUTO_MIGRATE=0 if you want to manage migrations
 *     manually (CI pipelines, multi-replica deploys where one process
 *     should drive migrations, etc.). Gateway will warn if pending
 *     migrations exist but won't apply them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { sql, dbBackend } from "./db";
import { logOpsEvent } from "./db";

const MIGRATIONS_TABLE = "schema_migrations";

/**
 * Where we look for migrations/, in priority order. The directory name
 * differs by backend so the same checkout can host both flavors:
 *   migrations/         — Postgres (production)
 *   migrations-sqlite/  — SQLite (single-binary trial)
 */
function findMigrationsDir(): string | null {
  const dirName = dbBackend === "sqlite" ? "migrations-sqlite" : "migrations";
  const candidates = [
    process.env.TOKENSMART_MIGRATIONS_DIR,
    // Docker production: gateway image WORKDIR is /app, migrations volume
    // is mounted at /app/migrations.
    path.resolve(process.cwd(), dirName),
    // Dev: we run from apps/gateway/ via `bun run dev`; migrations live
    // two levels up at the repo root.
    path.resolve(process.cwd(), `../../${dirName}`),
    // Belt-and-braces: source-relative resolution. import.meta.dir works
    // under Bun even when the entry script's cwd is something weird.
    typeof import.meta.dir === "string"
      ? path.resolve(import.meta.dir, `../../../${dirName}`)
      : null,
  ].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    if (existsSync(path.join(c, "001_init.sql"))) return c;
  }
  return null;
}

/**
 * Compute the sha256 of the file contents. Stored alongside each applied
 * row so we can detect drift — if a previously-applied migration file is
 * later edited (which is forbidden — migrations are immutable), the
 * gateway logs a loud warning at the next boot.
 */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Apply all pending migrations. Returns a summary so callers can log
 * a useful boot line.
 *
 * Throws on application failure so the gateway crashes with a clear
 * error at boot, rather than serving traffic against a half-migrated DB.
 */
export async function runPendingMigrations(): Promise<{
  applied: string[];
  alreadyApplied: number;
  drifted: string[];
  dir: string | null;
}> {
  if (process.env.TOKENSMART_AUTO_MIGRATE === "0") {
    console.log(
      "[migrate] TOKENSMART_AUTO_MIGRATE=0 — skipping. Apply migrations manually."
    );
    return { applied: [], alreadyApplied: 0, drifted: [], dir: null };
  }

  const dir = findMigrationsDir();
  if (!dir) {
    // Self-hosted users running the gateway from a checkout where they've
    // somehow nuked the migrations dir — warn but don't crash. Their DB
    // was likely seeded from a sibling source.
    console.warn(
      "[migrate] migrations/ directory not found — skipping. Set TOKENSMART_MIGRATIONS_DIR if it's elsewhere."
    );
    return { applied: [], alreadyApplied: 0, drifted: [], dir: null };
  }

  // Bootstrap: create the tracking table. Self-referential — IF NOT EXISTS
  // means re-applying is a no-op. We deliberately use a separate query
  // (not part of any migration file) so the table itself never needs a
  // chicken-and-egg migration.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename    TEXT PRIMARY KEY,
      sha256      TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Enumerate filesystem migrations in deterministic order.
  const files = readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b, "en"));

  // What's already applied?
  const appliedRows = await sql<{ filename: string; sha256: string }[]>`
    SELECT filename, sha256 FROM ${sql(MIGRATIONS_TABLE)}
  `;
  const appliedMap = new Map(appliedRows.map((r) => [r.filename, r.sha256]));

  const applied: string[] = [];
  const drifted: string[] = [];

  for (const filename of files) {
    const fullPath = path.join(dir, filename);
    const body = readFileSync(fullPath, "utf-8");
    const checksum = sha256(body);

    const existing = appliedMap.get(filename);
    if (existing) {
      if (existing !== checksum) {
        // Loud warning, do NOT re-apply. A drifted migration usually means
        // the developer edited a previously-applied file — that's a bug
        // (migrations are immutable; create a new file instead). Surface
        // it but don't try to "fix" by re-running, which could be
        // destructive.
        drifted.push(filename);
        console.warn(
          `[migrate] DRIFT: ${filename} contents changed since application. ` +
            `Migrations are append-only — create a new file instead of editing this one. ` +
            `Skipping (DB unchanged).`
        );
      }
      continue;
    }

    // Apply the file in a single transaction. If it crashes mid-file the
    // partial DDL gets rolled back, schema_migrations stays consistent,
    // and the gateway crashes with a clear error message naming the file.
    const startMs = Date.now();
    try {
      await sql.begin(async (tx) => {
        // Custom GUC consumed by gated DO blocks in migrations (e.g. 017's
        // dev-seed cleanup). Postgres allows arbitrary `<namespace>.<key>`
        // GUCs without registration. Set per-tx via SET LOCAL so it's
        // automatically scoped + cleaned at COMMIT, no leakage across
        // migrations or unrelated queries on this connection.
        //
        // SQLite shim doesn't speak SET LOCAL — and migrations-sqlite/
        // doesn't ship 017 either, so the GUC is Postgres-only.
        if (dbBackend === "postgres") {
          const allowDevSeed =
            process.env.NODE_ENV !== "production" ? "true" : "false";
          await tx.unsafe(
            `SET LOCAL tokensmart.allow_dev_seed = '${allowDevSeed}'`
          );
        }
        await tx.unsafe(body);
        await tx`
          INSERT INTO ${sql(MIGRATIONS_TABLE)} (filename, sha256, duration_ms)
          VALUES (${filename}, ${checksum}, ${Date.now() - startMs})
        `;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[migrate] FAILED ${filename}: ${msg}\n` +
          `[migrate] Refusing to start the gateway — fix the migration or roll back.`
      );
      // Best-effort ops audit row. Failures here are tolerable; the
      // crash below is the actual signal.
      await logOpsEvent({
        event: "schema.migration.failed",
        actor: "gateway-boot",
        targetType: "migration",
        targetId: filename,
        metadata: { error: msg, dir },
      }).catch(() => {});
      throw new Error(`Migration ${filename} failed: ${msg}`);
    }

    const elapsedMs = Date.now() - startMs;
    applied.push(filename);
    console.log(`[migrate] applied ${filename} (${elapsedMs}ms)`);

    await logOpsEvent({
      event: "schema.migration.applied",
      actor: "gateway-boot",
      targetType: "migration",
      targetId: filename,
      metadata: { sha256: checksum, duration_ms: elapsedMs },
    }).catch(() => {});
  }

  return {
    applied,
    alreadyApplied: appliedMap.size,
    drifted,
    dir,
  };
}
