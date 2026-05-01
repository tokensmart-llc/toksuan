-- 023: Durable loop-event window.
--
-- The original loop detector is process-local. This event table lets every
-- gateway replica and restart share the same recent fingerprint window.

CREATE TABLE IF NOT EXISTS loop_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loop_events_project_fingerprint_created
    ON loop_events(project_id, fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_loop_events_created
    ON loop_events(created_at);
