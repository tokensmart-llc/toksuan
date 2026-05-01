-- 021: Per-tag routing policies.
--
-- Background. Migration 019 introduced per-project versioned routing
-- policies — a single policy per project, derived from that project's
-- shadow A/B traffic. That works for projects where every request is
-- the same shape, but real customers commonly multiplex multiple
-- workloads in a single project (one chatbot + one codegen
-- microservice + one batch summarizer). One policy averaging across
-- all three is wrong: the optimal model for chitchat ≠ optimal model
-- for codegen, and the policy aggregator can't tell them apart from
-- the (task_type, complexity) bucket alone.
--
-- TokenSmart already lets the customer attribute requests with the
-- `x-ts-tag` header (migration 006). Migration 021 lets us learn a
-- separate policy per (project_id, tag) — chatbot prompts feed the
-- chatbot's policy, codegen feeds codegen's. The aggregator selects
-- which `ab_results` rows to consume by JOINing to `requests` on the
-- `tags` JSONB and filtering.
--
-- Schema shape: a nullable `tag` column, NULL = "default policy for
-- this project, applied to any request without a more-specific tagged
-- policy". We carry the unique constraint forward as
-- `(project_id, tag, version)`, with NULL treated as a value (Postgres
-- already does this for non-deferrable unique indexes since 15).
--
-- Activation lookup at request time:
--   1. Try `(project_id, request_tag, status='active')`.
--   2. Fall back to `(project_id, NULL, status='active')`.
--   3. Fall back to the shipped baseline policy.
--
-- This stays cheap on the hot path because the loader caches per
-- (project_id, tag) combo — see policy/loader.ts.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_policies' AND column_name = 'tag'
  ) THEN
    ALTER TABLE project_policies
      ADD COLUMN tag TEXT;
  END IF;
END$$;

-- Drop the old (project_id, version) unique constraint and replace
-- with one that includes tag. Postgres treats NULLs as distinct in
-- unique indexes by default, so two NULL-tag rows could collide on
-- (project_id, version) — we use NULLS NOT DISTINCT to fix that.
DROP INDEX IF EXISTS ux_project_policies_pid_version;
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_policies_pid_tag_version
  ON project_policies (project_id, tag, version) NULLS NOT DISTINCT;

-- Same for the active-row uniqueness — at most one active policy per
-- (project_id, tag) combination.
DROP INDEX IF EXISTS ux_project_policies_pid_active;
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_policies_pid_tag_active
  ON project_policies (project_id, tag) NULLS NOT DISTINCT
  WHERE status = 'active';

-- Index for the changelog page's per-tag history view.
CREATE INDEX IF NOT EXISTS idx_project_policies_pid_tag_generated
  ON project_policies (project_id, tag, generated_at DESC);
