-- 026: Per-project versioned embedding classifier artifact.
--
-- Background. v0.6.1 shipped a fastText-style embedding classifier that
-- replaces the regex heuristic for (task_type, complexity) decisions
-- when loaded and confident. Until this migration the artifact was
-- GLOBAL — one JSON file at apps/gateway/src/policy/embedding-classifier.json,
-- trained across every project's traffic merged together. That's fine
-- for cold-start self-host but wrong for the hosted multi-tenant
-- story: a legal-tech customer and a coding-agent customer have
-- entirely different vocabularies + task distributions, and a merged
-- classifier ends up worse for both than it could be for either.
--
-- Architectural parallel: this is EXACTLY the same story as 019's
-- per-project routing policy. The artifact is bigger in bytes (70KB vs
-- 10KB) but the lifecycle is identical — nightly retrain per paid
-- project, transactional promote, versioned history, rollback, pg_notify
-- fan-out for multi-replica reload. So we mirror the table 1:1.
--
-- Why keep the file-on-disk path too. Existing self-host operators
-- rely on the global artifact; ripping it out would silently regress
-- their routing quality. The runtime lookup order becomes:
--   1. project_embedding_classifiers WHERE project_id=X AND status='active'
--   2. global artifact file (apps/gateway/src/policy/embedding-classifier.json)
--   3. heuristic (cold-start / disabled)
-- Self-host single-tenant keeps working without touching the DB; cloud
-- multi-tenant gets the per-project precision bump nightly.

CREATE TABLE IF NOT EXISTS project_embedding_classifiers (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Monotonic per project. Set by the retrain CLI as MAX(version)+1 in
  -- a single transaction so concurrent retrains for the same project
  -- can't collide. Gateway reads MAX(version) WHERE status='active' for
  -- cache invalidation hints.
  version        INTEGER      NOT NULL,
  -- Mirror of project_policies.status semantics.
  --   'pending'     = newly written, quality floor not yet passed
  --   'active'      = currently served by the gateway. Exactly one per project.
  --   'superseded'  = previously active, kept for rollback / audit
  --   'rejected'    = below the quality floor; never served, but kept
  --                   for post-mortem (why did today's retrain skip?)
  status         TEXT         NOT NULL DEFAULT 'pending',
  -- Full ClassifierArtifact JSON — same shape the gateway's
  -- `embedding-classifier.ts` reads from disk.
  payload        JSONB        NOT NULL,
  -- How the row was made:
  --   'nightly_retrain' (cloud cron)
  --   'manual'          (operator ran the CLI with --project <uuid>)
  --   'rollback'        (re-promoted a prior version via dashboard button)
  --   'backfill'        (one-shot backfill for an existing paid project)
  source         TEXT         NOT NULL DEFAULT 'nightly_retrain',
  -- Rows considered in training. Separate from `validation.n_validation`
  -- inside the payload so the dashboard can show "trained on N samples"
  -- without parsing JSONB every render.
  sample_count   INTEGER      NOT NULL DEFAULT 0,
  -- Per-head validation accuracies, extracted from payload.validation
  -- into top-level columns so the dashboard changelog query + alert
  -- thresholds don't need to JSONB-index into the blob. Stored as REAL
  -- in [0, 1]; NULL when the training run had no validation set.
  task_type_accuracy    REAL,
  complexity_accuracy   REAL,
  -- Free-text rationale: "training N rows, task_type acc 0.87, ...
  -- promoted over v12 on Pareto-dominant per-class recall". Operator-
  -- facing summary for the changelog UI.
  notes          TEXT,
  generated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Set when status flips to 'active'. NULL for pending / rejected rows.
  activated_at   TIMESTAMPTZ
);

-- Natural key: (project_id, version). Training CLI uses ON CONFLICT
-- to stay idempotent across job re-runs.
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_embedding_classifiers_pid_version
  ON project_embedding_classifiers (project_id, version);

-- Hot-path read: gateway loader asks "what's the active classifier for
-- project X?" on every cache miss. Partial index keeps it O(1) — only
-- one row per project here at any time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_embedding_classifiers_pid_active
  ON project_embedding_classifiers (project_id)
  WHERE status = 'active';

-- Changelog read: "show last N versions of project X in reverse order".
CREATE INDEX IF NOT EXISTS idx_project_embedding_classifiers_pid_generated
  ON project_embedding_classifiers (project_id, generated_at DESC);

-- Status enum-ish check. Keeps misspellings out of the table. Done as
-- a CHECK rather than a real ENUM so future statuses (e.g. 'canary')
-- don't need ALTER TYPE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'project_embedding_classifiers'
      AND constraint_name = 'project_embedding_classifiers_status_check'
  ) THEN
    BEGIN
      ALTER TABLE project_embedding_classifiers
        ADD CONSTRAINT project_embedding_classifiers_status_check
        CHECK (status IN ('pending', 'active', 'superseded', 'rejected'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;
