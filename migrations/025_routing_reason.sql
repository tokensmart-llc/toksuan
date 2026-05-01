-- 025: Per-request routing provenance.
--
-- The dashboard's /routing-quality page can already split traffic by
-- (asked, landed) model pair. Operators almost always want a layer
-- finer: WHY did the gateway pick that target? Was it a baseline
-- policy bucket (chat:medium downgrade), a project routing rule
-- (regex match), or no routing at all (caller asked the model
-- directly)?
--
-- Two columns:
--
--   routing_reason  TEXT   Free-form debug string, exactly what
--                          appears in the gateway log. For baseline
--                          routes that's
--                            baseline:chat:simple→chat:medium:q=0.83:n=19:eps=0.10
--                          For project routing rules:
--                            rule:<rule_id>:from=<pattern>:to=<model>
--                          NULL when nothing rewrote body.model
--                          (caller's request hit upstream as-is).
--
--   routing_bucket  TEXT   Just the resolved (task_type, complexity)
--                          bucket the baseline policy actually used,
--                          shaped as 'chat:medium' / 'code:hard'
--                          / 'tool_use:medium' etc. NULL for project
--                          routing rules (rules are pattern-based,
--                          they don't classify a bucket) and NULL
--                          when no routing fired. Indexed because
--                          the dashboard groups by it.
--
-- Two columns instead of one to avoid forcing the dashboard to regex-
-- parse the reason on the hot read path: the bucket is what the
-- per-bucket breakdown queries against, the reason is for human
-- inspection on /requests/[id].
--
-- Both nullable + no default so existing rows stay NULL. This is
-- additive-only; old gateway versions writing without these columns
-- still work.

ALTER TABLE requests ADD COLUMN IF NOT EXISTS routing_reason TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS routing_bucket TEXT;

-- Partial index: only index rows where the bucket is set, so the
-- per-bucket aggregation queries on /routing-quality scan a tight
-- slice of the ledger instead of the whole table. Predicate matches
-- the dashboard's WHERE clause (`routing_bucket IS NOT NULL`).
CREATE INDEX IF NOT EXISTS idx_requests_routing_bucket_created
    ON requests(routing_bucket, created_at DESC)
    WHERE routing_bucket IS NOT NULL;
