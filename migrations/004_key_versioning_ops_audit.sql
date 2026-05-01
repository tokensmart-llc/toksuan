-- TokenSmart — Per-key versioning + operator audit log (v0.0.5)
--
-- Two related but independent additions, both needed for hosted production:
--
--   1. `user_provider_keys.master_key_fingerprint` — short fingerprint of
--      the master key that produced each row's ciphertext. Lets the
--      rotation script filter by `WHERE master_key_fingerprint = $OLD_FP`
--      instead of trying every row, and lets a future KMS-backed provider
--      route to the right KMS key version without trial-and-error.
--
--      Existing rows are left NULL on purpose — the gateway opportunistically
--      backfills them on first successful decrypt, the same way api_keys
--      backfilled `key_hash` after the v0.0.2 hashing migration.
--
--   2. `ops_audit_events` — operator-side audit log. Same shape as
--      `audit_events` except `user_id` is nullable, since rotation /
--      gateway-boot / system events have no end-user attribution. Keeps
--      the user-facing /audit page uncluttered while still giving SRE +
--      compliance a complete forensic trail.
--
-- Migration is additive + idempotent.

ALTER TABLE user_provider_keys
    ADD COLUMN IF NOT EXISTS master_key_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_user_provider_keys_master_fp
    ON user_provider_keys(master_key_fingerprint);

CREATE TABLE IF NOT EXISTS ops_audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL when the event has no end-user attribution (master key rotation,
    -- gateway boot/shutdown, schema migration applied, etc.). When non-null,
    -- it points at a specific user the event affected.
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    event           TEXT NOT NULL,
    target_type     TEXT,
    target_id       TEXT,
    -- Free-form actor identifier — could be a CI job id, an operator email,
    -- a service principal name. Distinct from `audit_events.actor_email`
    -- which is always a real signed-in user.
    actor           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip              INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_audit_events_event_created
    ON ops_audit_events(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_audit_events_created
    ON ops_audit_events(created_at DESC);
