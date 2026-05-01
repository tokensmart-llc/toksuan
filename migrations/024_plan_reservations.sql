-- 024: Pending plan-tier reservations (mirror of 022 for hosted plan caps).
--
-- The Free / Starter / etc. tiers each have TWO caps that fire whichever
-- comes first:
--
--   1. dailyMicroCentsLimit    — rolling-24h spend across the user's
--                                 projects ("$0.50 / day" on Free)
--   2. monthlyRequestLimit     — rolling-30d successful request count
--                                 ("250 requests / 30d" on Free)
--
-- Until now both checks read the `requests` ledger directly: a single
-- query "SELECT SUM(cost) FROM requests WHERE user_id=… AND status='success'
-- AND created_at > NOW() - INTERVAL '24 hours'". That works for serial
-- traffic. It does NOT work for an OpenClaw-style agent that fires
-- 20 parallel tool turns: every one of them sees the SAME pre-burst
-- spend, every one of them passes the gate, and we overshoot by 19
-- requests' worth of upstream cost — Stripe still charges us for that
-- usage, the user paid nothing extra.
--
-- Same fix as project budgets in migration 022: pre-deduct the worst-
-- case dimensions (estimated micro_cents on the daily side, +1 request
-- on the monthly side) into a short-lived `pending` row. The next
-- attempted reservation sums committed + pending and gates against
-- that. Successful upstream calls release the row immediately;
-- crashed / abandoned reservations age out via `expires_at`.
--
-- Two scalar columns instead of two tables: every plan reservation
-- consumes BOTH dimensions atomically (a single chat completion is
-- both "+~$0.0003" and "+1 request"). Splitting tables would require
-- a two-phase commit on a hot path for no schema-modeling benefit.

CREATE TABLE IF NOT EXISTS plan_reservations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Pre-deducted spend against the rolling-24h cap. May be 0 when the
    -- caller couldn't price the model (unknown_model fallback) — the
    -- monthly request count is still consumed in that case so we never
    -- silently bypass.
    amount_micro_cents  INTEGER NOT NULL DEFAULT 0 CHECK (amount_micro_cents >= 0),
    -- Pre-deducted request slots against the rolling-30d cap. Almost
    -- always 1; carved out as a column so a future "burst reservation"
    -- ("hold 5 turns at once for this OpenClaw agent") doesn't need a
    -- schema change.
    request_count       INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 0),
    status              TEXT NOT NULL DEFAULT 'pending',
    expires_at          TIMESTAMPTZ NOT NULL,
    released_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN ('pending', 'released'))
);

-- Indexed on (user_id, expires_at) for the partial-pending sum query
-- the gate runs on every request. Partial index keeps it tiny —
-- released rows age into a separate full-scan-friendly slice.
CREATE INDEX IF NOT EXISTS idx_plan_reservations_pending
    ON plan_reservations(user_id, expires_at)
    WHERE status = 'pending';
