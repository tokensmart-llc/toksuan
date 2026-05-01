-- TokenSmart — Advanced features pack (v0.0.2)
--
-- Additive, idempotent. Safe to run on a DB that already has the v0.0.1
-- schema applied. New install = 001 + 002 in order.
--
-- Touches:
--   - api_keys           : hashed-storage migration (key_hash + key_prefix + key_last4)
--   - requests           : `streamed` flag + `cache_savings_micro_cents`
--   - routing_rules      : `shadow_to_model` + `mode` (route | shadow | both)
--   - alert_rules        : extends event_type to include 'cost_anomaly'
--   - audit_events       : new — login / key / project / budget / billing trail
--   - ab_results         : new — outcomes of shadow-routed A/B comparisons
--
-- Rollback notes (if you ever need to undo this on a stage DB):
--   - DROP TABLE ab_results, audit_events;
--   - ALTER TABLE api_keys DROP COLUMN key_hash, DROP COLUMN key_prefix, DROP COLUMN key_last4;
--   - ALTER TABLE requests DROP COLUMN streamed, DROP COLUMN cache_savings_micro_cents;
--   - ALTER TABLE routing_rules DROP COLUMN shadow_to_model, DROP COLUMN mode;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===========================================================================
-- API key hashing
-- ===========================================================================
-- v0 stored API keys as plaintext. v0.2 stores SHA-256 hex digests in
-- `key_hash` and only keeps `key_prefix` + `key_last4` for human display.
--
-- We keep the legacy `key` column nullable rather than drop it: the gateway
-- accepts plaintext lookups during a transition window so existing keys keep
-- working. New keys are inserted with `key = NULL` and the hash filled in.

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS key_hash    TEXT,
    ADD COLUMN IF NOT EXISTS key_prefix  TEXT,
    ADD COLUMN IF NOT EXISTS key_last4   TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_keys' AND column_name = 'key' AND is_nullable = 'YES'
    ) THEN
        EXECUTE 'ALTER TABLE api_keys ALTER COLUMN key DROP NOT NULL';
    END IF;
END $$;

-- Backfill hash + display fragments for any plaintext rows that don't have them.
UPDATE api_keys
   SET key_hash = ENCODE(DIGEST(key, 'sha256'), 'hex')
 WHERE key IS NOT NULL AND key_hash IS NULL;

UPDATE api_keys
   SET key_prefix = LEFT(key, 7),
       key_last4  = RIGHT(key, 4)
 WHERE key IS NOT NULL AND key_prefix IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- ===========================================================================
-- Requests: streaming + cache-savings columns
-- ===========================================================================

ALTER TABLE requests
    ADD COLUMN IF NOT EXISTS streamed                  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS cache_savings_micro_cents INTEGER NOT NULL DEFAULT 0;

-- ===========================================================================
-- Routing rules: shadow + mode
-- ===========================================================================
-- `mode = 'route'`   classic semantic-route (default; matches v0 behavior)
-- `mode = 'shadow'`  call the original AND `shadow_to_model` in parallel,
--                    serve the original, write an ab_results row.
-- `mode = 'both'`    route as before AND fire a shadow call against the
--                    *original* model so you can see what would have happened.

ALTER TABLE routing_rules
    ADD COLUMN IF NOT EXISTS shadow_to_model TEXT,
    ADD COLUMN IF NOT EXISTS mode            TEXT NOT NULL DEFAULT 'route';

-- ===========================================================================
-- Audit events
-- ===========================================================================
-- Free-form ledger of human-meaningful actions. Anything a hosted user might
-- want to retroactively explain or dispute lands here. Cheap to insert,
-- queried only on demand from the /audit page.

CREATE TABLE IF NOT EXISTS audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id)    ON DELETE SET NULL,
    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
    event           TEXT NOT NULL,                 -- e.g. 'login', 'api_key.created'
    target_type     TEXT,                          -- e.g. 'api_key', 'project', 'budget'
    target_id       TEXT,                          -- usually a UUID, but kept TEXT
    actor_email     TEXT,                          -- denormalized for fast display
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip              INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_created
    ON audit_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_project_created
    ON audit_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_created
    ON audit_events(event, created_at DESC);

-- ===========================================================================
-- A/B shadow-routing results
-- ===========================================================================
-- One row per shadow comparison. The "primary" side is what the user actually
-- received; the "shadow" side is what would have happened if the request had
-- gone to the experimental model. Cost saved (positive) = primary - shadow.

CREATE TABLE IF NOT EXISTS ab_results (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    primary_request_id          UUID REFERENCES requests(id) ON DELETE SET NULL,
    primary_model               TEXT NOT NULL,
    primary_provider            TEXT NOT NULL,
    primary_input_tokens        INTEGER NOT NULL DEFAULT 0,
    primary_output_tokens       INTEGER NOT NULL DEFAULT 0,
    primary_cost_micro_cents    INTEGER NOT NULL DEFAULT 0,
    primary_latency_ms          INTEGER,
    shadow_model                TEXT NOT NULL,
    shadow_provider             TEXT NOT NULL,
    shadow_input_tokens         INTEGER NOT NULL DEFAULT 0,
    shadow_output_tokens        INTEGER NOT NULL DEFAULT 0,
    shadow_cost_micro_cents     INTEGER NOT NULL DEFAULT 0,
    shadow_latency_ms           INTEGER,
    shadow_status               TEXT NOT NULL DEFAULT 'success',
    shadow_response_body        JSONB,
    shadow_error                TEXT,
    fingerprint                 TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ab_results_project_created
    ON ab_results(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ab_results_models
    ON ab_results(primary_model, shadow_model);
