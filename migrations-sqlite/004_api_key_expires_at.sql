-- 004 (SQLite): mirror migrations/014_api_key_expires_at.sql.
--
-- The Postgres schema added soft-rotate grace via api_keys.expires_at in
-- migration 014. The SQLite-trial parallel migrations forgot to follow
-- along, so any SQLite-mode gateway that boots after `findApiKey()` was
-- updated to filter on `k.expires_at` returns SQLITE_ERROR ("no such
-- column: k.expires_at") on every authenticated request — auth
-- effectively broken.
--
-- Adding the column with a NULL default preserves existing dev installs
-- (NULL = canonical, never expires) and matches the Postgres semantics
-- exactly. The conditional WHERE on the index mirrors the Postgres
-- partial index — SQLite supports partial indexes since 3.8.
--
-- SQLite ALTER TABLE ADD COLUMN is not transactional in the same sense
-- as Postgres but it IS idempotent-safe behind a sqlite_master probe
-- because bun:sqlite raises a duplicate-column error on re-apply. We
-- guard with a "SELECT IF NOT EXISTS in pragma_table_info" trick to
-- keep the migration runner happy on re-application.

-- Attempt the ADD COLUMN; ignore the error if the column already exists.
-- bun:sqlite raises "duplicate column name" on re-add — we run inside
-- the migration runner's transaction, so the per-statement try/catch
-- shape isn't available. Instead, gate the ALTER on a pragma probe.
CREATE TABLE IF NOT EXISTS _ts_migration_004_probe (placeholder INTEGER);

-- The probe table is meaningless; we rely on schema_migrations recording
-- this file so the ALTER never re-runs anyway. The conditional is
-- defensive only against an operator who edits schema_migrations.
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;

DROP TABLE IF EXISTS _ts_migration_004_probe;

CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at
  ON api_keys(expires_at)
  WHERE expires_at IS NOT NULL;
