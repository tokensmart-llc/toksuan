-- TokenSmart — Reversible compression store (M4)
--
-- Additive + idempotent. Safe on DBs already past 033.
--
-- When the context-compression pipeline rewrites a tool/function message
-- in `optimize` mode AND the operator opted into storage
-- (TOKENSMART_CONTEXT_COMPRESS_STORE=1), the pre-compression original is
-- persisted here alongside the compressed form, scoped to
-- (project_id, request_id). This makes compression reversible: an
-- operator can retrieve the untouched bytes from the dashboard / the
-- gateway's internal endpoint instead of losing them forever.
--
-- Privacy/retention: these rows hold raw tool output (may contain PII /
-- secrets in logs). They are swept by the same retention window as
-- `requests` (see scripts/sweep-old-requests.ts) via the request_id FK
-- ON DELETE CASCADE, so deleting a request also deletes its originals.

CREATE TABLE IF NOT EXISTS compressed_blobs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id         UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    project_id         UUID REFERENCES projects(id) ON DELETE CASCADE,
    message_index      INTEGER NOT NULL,
    strategy           TEXT NOT NULL,
    hash               TEXT NOT NULL,
    original_content   TEXT NOT NULL,
    compressed_content TEXT NOT NULL,
    original_chars     INTEGER NOT NULL DEFAULT 0,
    compressed_chars   INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary retrieval path: "show me the originals for this request".
CREATE INDEX IF NOT EXISTS idx_compressed_blobs_request
    ON compressed_blobs(request_id);

-- Tenant-scoped lookups + dedupe-by-hash analytics.
CREATE INDEX IF NOT EXISTS idx_compressed_blobs_project_hash
    ON compressed_blobs(project_id, hash);
