-- 002: Pending budget reservations for SQLite trial mode.

CREATE TABLE IF NOT EXISTS budget_reservations (
  id                  TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  budget_id           TEXT REFERENCES budgets(id) ON DELETE CASCADE,
  period              TEXT NOT NULL,
  amount_micro_cents  INTEGER NOT NULL CHECK (amount_micro_cents >= 0),
  status              TEXT NOT NULL DEFAULT 'pending',
  expires_at          TEXT NOT NULL,
  released_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (period IN ('daily', 'monthly')),
  CHECK (status IN ('pending', 'released'))
);

CREATE INDEX IF NOT EXISTS idx_budget_reservations_pending
  ON budget_reservations(project_id, period, expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_budget_reservations_budget
  ON budget_reservations(budget_id, created_at DESC);
