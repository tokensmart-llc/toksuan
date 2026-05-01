-- 006 (SQLite): mirror migrations/025_routing_reason.sql.
--
-- See the Postgres copy for the full reasoning. Two new nullable
-- columns on the requests table so the dashboard's /routing-quality
-- page can split traffic by the policy bucket the baseline router
-- actually picked.
--
-- SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` but the
-- migration runner records this file in `schema_migrations` after
-- success, so re-application is prevented at the orchestration
-- layer. Same pattern as migrations-sqlite/004 + 005.

ALTER TABLE requests ADD COLUMN routing_reason TEXT;
ALTER TABLE requests ADD COLUMN routing_bucket TEXT;

CREATE INDEX IF NOT EXISTS idx_requests_routing_bucket_created
    ON requests(routing_bucket, created_at DESC)
    WHERE routing_bucket IS NOT NULL;
