-- TokenSmart — Request tags (v0.1.0)
--
-- Additive + idempotent. Safe on DBs already past 005.
--
-- Adds per-request `tags JSONB` for cost attribution. Populated from the
-- `x-ts-tag` request header. Format is an object of string→string,
-- e.g. {"feature": "summarization", "team": "growth", "user": "u_42"}.
--
-- Why JSONB and not separate columns:
--   - Customers tag with arbitrary dimensions we can't anticipate
--     (feature, team, user, env, customer_id, A/B test arm, ...)
--   - JSONB + GIN index is fast enough for the cardinality we expect
--     (millions of rows, dozens of distinct tag combinations per project)
--   - No schema migration needed when a customer adds a new tag dimension
--
-- Why NOT TEXT[] of "key=value":
--   - Loses key/value typing — can't easily ask "spend by feature only"
--   - Indexing is awkward for the "rows where tag.X = Y" query
--
-- Default empty object so JOIN aggregations don't have to coalesce NULL.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'requests' AND column_name = 'tags'
  ) THEN
    ALTER TABLE requests
      ADD COLUMN tags JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END$$;

-- GIN index for "where tags @> '{key: value}'" queries the dashboard runs
-- to populate the "Spend by tag" card. Partial — only index rows that
-- actually carry a tag, since most requests in a fresh DB have none.
CREATE INDEX IF NOT EXISTS idx_requests_tags_gin
  ON requests USING GIN (tags)
  WHERE tags <> '{}'::jsonb;
