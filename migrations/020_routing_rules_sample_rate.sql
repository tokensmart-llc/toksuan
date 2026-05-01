-- 020: Sample rate on routing_rules.
--
-- Background. The shadow / both modes today fire on EVERY request that
-- matches the rule's regex AND scores below the threshold. For a high-
-- traffic project that's fine for ledger experiments (you want a 1:1
-- view of "what would the alternative model have done") but it doubles
-- the upstream bill — every primary call gets a parallel shadow call,
-- whether or not we have enough samples already to be statistically
-- confident.
--
-- For per-project policy training (migration 019) we need the OPPOSITE
-- behavior: a small, randomly-sampled trickle of shadow rows, just
-- enough to keep the aggregator's per-bucket model estimates fresh.
-- 5–10% of qualifying traffic is plenty after the first few hundred
-- samples land in any given (task_type, complexity, model) cell.
--
-- Shape. A floating-point `sample_rate` in [0, 1]. NULL or 1.0 keeps
-- the legacy "fire on every match" behavior. Any other value means
-- "fire on `Math.random() < sample_rate` of matching requests". The
-- gate lives in apps/gateway/src/router.ts so the existing rule
-- evaluation order (pattern → threshold → sample) stays observable.
--
-- Why per-rule, not per-project. A project might want:
--   - Aggressive shadow on a brand-new model (sample_rate = 1.0, fast
--     calibration burst) for the first 24h
--   - Steady-state shadow on incumbent models (sample_rate = 0.05,
--     just enough to detect drift)
-- Both at the same time, on the same project. Per-rule lets the
-- operator dial each lane independently.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'routing_rules' AND column_name = 'sample_rate'
  ) THEN
    ALTER TABLE routing_rules
      ADD COLUMN sample_rate REAL;
  END IF;
END$$;

-- Range constraint: [0, 1] OR NULL. NULL semantics = "fire on every
-- match" (legacy). 0 = "never fire" (lets you keep a rule disabled
-- for diff/audit without losing the row).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'routing_rules'
      AND constraint_name = 'routing_rules_sample_rate_range'
  ) THEN
    BEGIN
      ALTER TABLE routing_rules
        ADD CONSTRAINT routing_rules_sample_rate_range
        CHECK (sample_rate IS NULL OR (sample_rate >= 0.0 AND sample_rate <= 1.0));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;
