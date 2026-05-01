-- TokenSmart — anonymous self-host aggregate telemetry collector (v0.7)
--
-- Hosted-only collection table. Self-hosted deployments never phone home by
-- default; when operators opt in via TOKENSMART_ANON_TELEMETRY=1, their gateway
-- can POST daily aggregate payloads to /api/telemetry/agent-spend.
--
-- Payload privacy contract:
--   - aggregate counts/sums + route pairs only
--   - no prompts, responses, request IDs, API keys, user emails, or project names
--   - local sender suppresses low-count route rows before upload
--
-- We store the raw JSONB payload as received so the public aggregate pipeline
-- can evolve independently (schema_version gates readers). Summary columns are
-- duplicated for indexing and basic ops inspection.

CREATE TABLE IF NOT EXISTS anonymous_telemetry_daily (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_version                  INTEGER NOT NULL,
    source                          TEXT NOT NULL,
    deployment_hash                 TEXT NOT NULL,
    window_start                    TIMESTAMPTZ NOT NULL,
    window_end                      TIMESTAMPTZ NOT NULL,
    request_count                   INTEGER NOT NULL DEFAULT 0,
    routed_request_count            INTEGER NOT NULL DEFAULT 0,
    loops_blocked_count             INTEGER NOT NULL DEFAULT 0,
    budget_block_count              INTEGER NOT NULL DEFAULT 0,
    plan_block_count                INTEGER NOT NULL DEFAULT 0,
    error_count                     INTEGER NOT NULL DEFAULT 0,
    routing_saving_micro_cents      BIGINT NOT NULL DEFAULT 0,
    cache_saving_micro_cents        BIGINT NOT NULL DEFAULT 0,
    route_row_count                 INTEGER NOT NULL DEFAULT 0,
    payload                         JSONB NOT NULL,
    received_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (deployment_hash, window_start, window_end, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_anonymous_telemetry_daily_window
    ON anonymous_telemetry_daily(window_start DESC, window_end DESC);

CREATE INDEX IF NOT EXISTS idx_anonymous_telemetry_daily_received
    ON anonymous_telemetry_daily(received_at DESC);

