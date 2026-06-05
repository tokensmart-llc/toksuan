-- 010 (SQLite): mirror migrations/034_compressed_blobs.sql.
--
-- See the Postgres copy for the full reasoning. Reversible compression
-- store: pre-compression originals keyed by (project_id, request_id) so
-- operators can retrieve the untouched tool output.
--
-- SQLite notes:
--   - UUID/TIMESTAMPTZ → TEXT, JSONB not needed (raw text payloads).
--   - id default uses the same randomblob() composition the shim emits
--     for gen_random_uuid(); inline here so the column has a default even
--     when rows are inserted without an explicit id.
--   - No FK to requests(id): the SQLite trial schema keeps FKs minimal,
--     and retention sweeps run the same DELETEs. re-application is
--     prevented at the migration-runner layer (recorded in
--     schema_migrations), same pattern as the other sqlite migrations.

CREATE TABLE IF NOT EXISTS compressed_blobs (
    id                 TEXT PRIMARY KEY DEFAULT (
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(6)))
    ),
    request_id         TEXT NOT NULL,
    project_id         TEXT,
    message_index      INTEGER NOT NULL,
    strategy           TEXT NOT NULL,
    hash               TEXT NOT NULL,
    original_content   TEXT NOT NULL,
    compressed_content TEXT NOT NULL,
    original_chars     INTEGER NOT NULL DEFAULT 0,
    compressed_chars   INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_compressed_blobs_request
    ON compressed_blobs(request_id);

CREATE INDEX IF NOT EXISTS idx_compressed_blobs_project_hash
    ON compressed_blobs(project_id, hash);
