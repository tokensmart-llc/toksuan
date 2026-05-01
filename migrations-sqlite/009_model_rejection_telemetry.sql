-- 009 (SQLite): mirror migrations/028_model_rejection_telemetry.sql.
--
-- Same shape; SQLite-mode installs are mostly single-tenant dev boxes
-- that rarely see `no_credentials` rejections (the operator sets up
-- one env API key and sticks with it), but we ship the table for
-- symmetry so the dashboard read path works uniformly.

CREATE TABLE IF NOT EXISTS ops_model_rejections (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),
    model           TEXT NOT NULL,
    provider_guess  TEXT,
    reason          TEXT NOT NULL CHECK (reason IN ('no_template', 'no_credentials')),
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    hit_count       INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

-- SQLite's unique-index on expression needs the same COALESCE trick
-- (treats empty string == empty string → two NULL projects collapse).
CREATE UNIQUE INDEX IF NOT EXISTS ux_ops_model_rejections_model_reason_project
    ON ops_model_rejections (model, reason, COALESCE(project_id, ''));

CREATE INDEX IF NOT EXISTS idx_ops_model_rejections_last_seen
    ON ops_model_rejections (last_seen_at DESC);
