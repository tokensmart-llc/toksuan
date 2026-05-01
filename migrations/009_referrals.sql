-- TokenSmart — Referral commission program (v0.2.x)
--
-- Additive + idempotent. Safe on DBs already past 008.
--
-- Closes the "small hooks" gap from the 11-condition audit. Each user gets
-- one stable referral code (created on demand). When a NEW signup hits the
-- billing page with `?ref=<code>` (or completes Stripe checkout with that
-- code in client_reference_id metadata), we record the attribution and pay
-- the referrer 20% of the first 12 months of the new customer's subscription
-- as Stripe credit.
--
-- Schema:
--   users.referral_code      — stable per-user (NULL until they ask for one)
--   users.referred_by_user_id — set ONCE on signup; nulls afterwards
--                                 (we never let a user "switch" referrers)
--   referral_credits         — append-only ledger of credits granted to
--                                 the referrer for each invoice the
--                                 referee has paid. Powers the dashboard
--                                 "Referrals" card and the periodic
--                                 settle job that mints Stripe coupons.
--
-- The Stripe-side mechanism is "customer balance credit" via
-- `Stripe.Customers.createBalanceTransaction` (a negative integer, in the
-- customer's currency, applied against the next invoice). The `applied_at`
-- column tracks whether we've called Stripe yet — the actions/route
-- handler is idempotent on (referee_invoice_id) so duplicate webhooks
-- don't double-credit.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'referral_code'
  ) THEN
    ALTER TABLE users
      ADD COLUMN referral_code TEXT UNIQUE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'referred_by_user_id'
  ) THEN
    ALTER TABLE users
      ADD COLUMN referred_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_users_referred_by
  ON users (referred_by_user_id)
  WHERE referred_by_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_credits (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The referrer earns the credit. Indexed for the "your earnings" UI.
    referrer_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The referee whose invoice triggered this credit. NULL-on-delete so
    -- deleting a referee user doesn't cascade-wipe historical earnings.
    referee_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    -- The Stripe invoice that the credit is keyed off — UNIQUE so a webhook
    -- replay never double-credits.
    referee_invoice_id      TEXT NOT NULL UNIQUE,
    -- The original invoice subtotal in micro_cents (1 cent = 1000 micro_cents,
    -- consistent with the rest of the codebase). Stored for transparency
    -- on the "Referrals" UI; the credit_micro_cents is what we actually pay.
    referee_invoice_subtotal_micro_cents BIGINT NOT NULL,
    -- The credit we'll grant the referrer (20% of the subtotal, capped at
    -- the first 12 months of the referee's subscription tenure). Computed
    -- by the webhook handler at insert time from the program rules below
    -- so we have an immutable record even if the rules later change.
    credit_micro_cents      BIGINT NOT NULL,
    -- Stripe customer balance transaction ID after we've actually granted
    -- the credit. NULL until applied — the periodic settle job picks up
    -- NULLs and calls Stripe.
    stripe_balance_txn_id   TEXT,
    -- Timestamp when stripe_balance_txn_id was set. Pure observability.
    applied_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_credits_referrer
  ON referral_credits (referrer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referral_credits_pending
  ON referral_credits (created_at)
  WHERE applied_at IS NULL;
