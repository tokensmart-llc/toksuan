-- TokenSmart — billing transfer intents (v0.4.x, A5 follow-up)
--
-- Context: v0.4 shipped in-product owner transfer, but deliberately
-- kept the Stripe subscription on the old owner. That's the safe
-- default — auto-swapping subscriptions has a real "what if the new
-- owner's card is declined" failure mode. But enterprise customers
-- eventually do want "ownership + billing both move to the new
-- owner" as one coordinated action. This migration + the new
-- `/organization/[id]` flow delivers that WITHOUT the high-risk
-- automated Stripe orchestration:
--
--   1. The old owner ticks "also transfer billing" on the transfer
--      form. This writes a `billing_transfer_intents` row.
--   2. Both parties see an explanatory card on `/billing`: the old
--      owner's card says "transferring to X — keep your subscription
--      active until they confirm"; the new owner's card says
--      "<email> wants you to take over billing; start your own
--      subscription at /billing to complete the transfer".
--   3. When the new owner completes a Stripe Checkout for the same
--      plan, the existing `customer.subscription.created` webhook
--      handler flips the intent's `completed_at` AND cancels the
--      old owner's subscription. That last bit is scoped to "same
--      org, pending intent in this pair" so random Stripe Checkouts
--      never cancel anyone else's subscription.
--   4. If the new owner never claims, the intent auto-expires at
--      30 days — old owner's subscription is unaffected.
--
-- Rows are append-only in terms of state (null → set once); the
-- table is small (one row per transfer attempt, most orgs never
-- transfer), so no retention sweep needed beyond whatever the
-- customer data-deletion cron does.

CREATE TABLE IF NOT EXISTS billing_transfer_intents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    from_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Free-form note for the recipient. UI-constrained to 280 chars.
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    -- Set the moment either the to_user_id starts a new Stripe
    -- subscription against this org OR an admin manually marks it
    -- complete. Stripe-webhook completion is the primary path; the
    -- manual path exists for offline migrations (wire transfer, etc).
    completed_at    TIMESTAMPTZ,
    -- Set when EITHER party cancels via the UI. After cancellation
    -- the intent is inert — billing stays where it was.
    cancelled_at    TIMESTAMPTZ,
    cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Stripe subscription id of the from_user at intent creation
    -- time. When completed, the webhook handler cancels this
    -- specific subscription so later random subscription churn
    -- can never accidentally cascade into a cancellation.
    from_stripe_subscription_id TEXT
);

-- "At most one pending intent per org" — PostgreSQL partial unique
-- index. Deliberately omits `expires_at > NOW()` from the predicate
-- because `NOW()` is not IMMUTABLE and Postgres rejects it in index
-- predicates. Instead, the `pending` definition for the DB-level
-- invariant is simply "not completed AND not cancelled". Stale
-- entries (no one finished them before `expires_at` elapsed) stay
-- "pending" at the index level; the application layer (see
-- `createBillingTransferIntent` in apps/dashboard/src/lib/db.ts)
-- marks them cancelled before inserting a replacement so a user
-- can always create a fresh intent once the old one has effectively
-- expired.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_billing_transfer_intents_pending
  ON billing_transfer_intents(organization_id)
  WHERE completed_at IS NULL
    AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_transfer_intents_from_user
  ON billing_transfer_intents(from_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_transfer_intents_to_user
  ON billing_transfer_intents(to_user_id, created_at DESC);
