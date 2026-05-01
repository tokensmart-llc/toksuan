-- 003: Durable loop-event window for SQLite trial mode.

CREATE TABLE IF NOT EXISTS loop_events (
  id           TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_loop_events_project_fingerprint_created
  ON loop_events(project_id, fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_loop_events_created
  ON loop_events(created_at);
