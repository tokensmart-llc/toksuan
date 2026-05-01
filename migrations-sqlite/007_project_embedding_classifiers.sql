-- 007 (SQLite): mirror migrations/026_project_embedding_classifiers.sql.
--
-- SQLite-mode installs won't typically run per-project nightly retrain
-- (the orchestration assumes Postgres for `FOR UPDATE` row locking +
-- pg_notify fan-out), but we ship the table anyway so the dashboard
-- read-side queries work uniformly across backends. A SQLite-mode
-- install that wants per-project classifiers can still populate this
-- table manually via a custom pipeline.
--
-- Differences from Postgres:
--   - Primary key is INTEGER autoincrement (SQLite convention) instead
--     of UUID gen_random_uuid() (no gen_random_uuid extension).
--   - ForEign key references retain ON DELETE CASCADE; SQLite honors
--     this when `PRAGMA foreign_keys = ON` (set by the shim at boot).
--   - No DO-block for adding the CHECK constraint — it's inline.
--   - TIMESTAMPTZ → TEXT storing ISO8601 UTC (sql-driver normalizes
--     Date binding on the shim side).

CREATE TABLE IF NOT EXISTS project_embedding_classifiers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'active', 'superseded', 'rejected')),
  payload               TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'nightly_retrain',
  sample_count          INTEGER NOT NULL DEFAULT 0,
  task_type_accuracy    REAL,
  complexity_accuracy   REAL,
  notes                 TEXT,
  generated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
  activated_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_project_embedding_classifiers_pid_version
  ON project_embedding_classifiers (project_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS ux_project_embedding_classifiers_pid_active
  ON project_embedding_classifiers (project_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_project_embedding_classifiers_pid_generated
  ON project_embedding_classifiers (project_id, generated_at DESC);
