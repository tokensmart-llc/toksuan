-- 022: Pending budget reservations.
--
-- Finished `requests` rows are not enough for hard budget enforcement:
-- concurrent agent turns can all pass the "current spend < limit" check before
-- any of them writes its final usage. This table records short-lived in-flight
-- reservations so the next request sees committed spend + pending spend.

CREATE TABLE IF NOT EXISTS budget_reservations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    budget_id           UUID REFERENCES budgets(id) ON DELETE CASCADE,
    period              TEXT NOT NULL,
    amount_micro_cents  INTEGER NOT NULL CHECK (amount_micro_cents >= 0),
    status              TEXT NOT NULL DEFAULT 'pending',
    expires_at          TIMESTAMPTZ NOT NULL,
    released_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (period IN ('daily', 'monthly')),
    CHECK (status IN ('pending', 'released'))
);

CREATE INDEX IF NOT EXISTS idx_budget_reservations_pending
    ON budget_reservations(project_id, period, expires_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_budget_reservations_budget
    ON budget_reservations(budget_id, created_at DESC);
