-- 019: Per-project versioned routing policy.
--
-- Background. Until v0.5.x the gateway used a single shipped
-- `baseline-policy.json` for every project. That artifact comes from public
-- benchmarks (policy code eval, policy chat eval, etc.) and is a perfectly good cold-start
-- prior — but it doesn't know anything about a particular customer's prompt
-- mix. Two customers on the same plan can have wildly different
-- (task_type × complexity) distributions, and the cheapest model for chat/
-- medium on benchmark prompts may not be the cheapest for *their* chat/
-- medium prompts.
--
-- The fix is per-project policy versioning: a nightly job reads
-- `ab_results` for the project, blends what we observed there with the
-- shipped baseline (Bayesian-style — prior weight ≈ 20 samples), and
-- writes a new policy row. The gateway hot path picks the latest active
-- row per project_id; misses fall back to the shipped artifact.
--
-- Why a single JSONB column for the policy. The shape is identical to
-- `apps/gateway/src/policy/baseline-policy.json` — buckets[] +
-- per-bucket Pareto-frontier models. Storing it as JSONB instead of
-- exploding it into rows means (a) a project_policies row survives a
-- shape extension (new fields just appear in the JSONB), (b) reading
-- the active policy is one indexed lookup + a JSON parse — no joins,
-- no N+1, fits the hot path, and (c) anyone debugging a routing
-- decision can `psql` the row and SELECT payload->'lookup'->'chat:medium'
-- directly.
--
-- Versioning + atomic activation. Every retrain inserts a new row with
-- status='pending'. After a sanity check (no bucket collapsed to a
-- single dominated model, total prior samples + observed n above some
-- floor, etc.) the same retrain run flips status='active' and demotes
-- the previous active row to status='superseded'. Failure leaves the
-- prior active row in place — there's never a window where the gateway
-- has to serve from a half-trained policy.
--
-- Why we keep `superseded` rows around. Rollback. The dashboard shows
-- a per-project policy changelog; if a retrain regresses real-world
-- savings the operator can `UPDATE … SET status='active'` on the
-- previous row. Pruning is an opt-in scheduled job, not a constraint.
--
-- Self-hosters get the *table* and the *retrain CLI* — they just have
-- to wire their own cron. Cloud customers get the cron + judge LLM
-- key bundled (paid feature).

CREATE TABLE IF NOT EXISTS project_policies (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Monotonic per project. Set by the retrain CLI (max(version)+1 in a
  -- single transaction with the INSERT). Gateway reads MAX(version)
  -- WHERE status='active' for cache invalidation hints.
  version       INTEGER      NOT NULL,
  -- 'pending' = newly written, sanity-check not yet passed.
  -- 'active'  = currently served by the gateway. Exactly one per project.
  -- 'superseded' = previously active, kept for rollback/audit.
  -- 'rejected' = sanity check failed. Never served.
  status        TEXT         NOT NULL DEFAULT 'pending',
  -- Full BaselinePolicy JSON — same shape as baseline-policy.json.
  payload       JSONB        NOT NULL,
  -- How the row was made: 'retrain' (nightly cron), 'manual' (operator
  -- ran the CLI), 'rollback' (re-promoted a superseded row), 'baseline'
  -- (initial seed copied from the shipped artifact).
  source        TEXT         NOT NULL DEFAULT 'retrain',
  -- Number of ab_results rows the aggregator considered for this version.
  -- Useful for the changelog UI ("trained on 1,247 samples over 7 days").
  sample_count  INTEGER      NOT NULL DEFAULT 0,
  -- Free-text rationale: which buckets changed, by how much. The
  -- aggregator writes a one-line-per-bucket diff here that the dashboard
  -- renders as the changelog entry.
  notes         TEXT,
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Set when status flips to 'active'. NULL for pending/rejected rows.
  activated_at  TIMESTAMPTZ
);

-- Uniqueness: per project the (project_id, version) is the row's
-- natural key. Lets the retrain CLI use ON CONFLICT to be idempotent
-- across job re-runs.
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_policies_pid_version
  ON project_policies (project_id, version);

-- Hot-path read: gateway looks up "what's the active policy for this
-- project?" on every request that misses the in-process cache. Partial
-- index keeps it O(1) — only one row per project here at any time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_policies_pid_active
  ON project_policies (project_id)
  WHERE status = 'active';

-- Changelog query: "show the last N versions of this project's policy
-- in reverse-chronological order".
CREATE INDEX IF NOT EXISTS idx_project_policies_pid_generated
  ON project_policies (project_id, generated_at DESC);

-- Constraint: status enum-ish. Keeps misspellings out of the table.
-- Done as a CHECK rather than a real ENUM so we can extend the set
-- without an ALTER TYPE in a future migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'project_policies'
      AND constraint_name = 'project_policies_status_check'
  ) THEN
    BEGIN
      ALTER TABLE project_policies
        ADD CONSTRAINT project_policies_status_check
        CHECK (status IN ('pending', 'active', 'superseded', 'rejected'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;

-- Per-project learning toggle. Lives on `projects` because that's
-- where billing/plan info already hangs. Cloud sets this to TRUE on
-- subscription activation; OSS leaves it FALSE so self-hosters opt in
-- explicitly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'learning_enabled'
  ) THEN
    ALTER TABLE projects
      ADD COLUMN learning_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END$$;
