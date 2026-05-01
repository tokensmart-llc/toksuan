-- TokenSmart — Initial schema (v0.0.1)
-- Applied automatically on first Postgres boot via docker-compose.

-- Users: hosted-mode account holders. Self-hosted single-tenant installs
-- can leave this table empty and set TOKENSMART_AUTH_ENABLED=0 on the
-- dashboard to skip the login gate entirely.
CREATE TABLE IF NOT EXISTS users (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                   TEXT UNIQUE NOT NULL,
    name                    TEXT,
    plan                    TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'pro' | 'team'
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sessions: opaque bearer tokens set as HTTP-only cookies on the dashboard.
CREATE TABLE IF NOT EXISTS sessions (
    token           TEXT PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Magic links / OTPs: one row per login attempt. Either `token` (click link)
-- or `code` (enter OTP) can be used to consume the row, whichever comes back
-- first. Both are invalidated by `consumed_at IS NOT NULL`.
CREATE TABLE IF NOT EXISTS magic_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    token           TEXT UNIQUE NOT NULL,
    code            TEXT NOT NULL,                     -- 6-digit numeric OTP
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email, created_at DESC);

-- Projects: a logical grouping of requests. Usually = one app or one agent.
-- `user_id` is nullable: self-hosted installs and the seeded dev project
-- remain usable without a user; hosted installs create projects owned by the
-- signed-in user.
CREATE TABLE IF NOT EXISTS projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

-- API keys: belong to projects. Used to authenticate gateway requests.
-- v0: keys are stored in plaintext for simplicity. Hash them in v0.2.
CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key             TEXT UNIQUE NOT NULL,
    name            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);

-- Requests: one row per request that flowed through the gateway.
-- This is the core ledger. Every cost / token / latency lives here.
CREATE TABLE IF NOT EXISTS requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
    api_key_id          UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    provider            TEXT NOT NULL,                  -- 'openai', 'anthropic', etc
    model               TEXT NOT NULL,                  -- 'gpt-4o-mini', 'claude-3-5-sonnet', etc
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    -- How many of `input_tokens` the upstream served from its prompt cache.
    -- Billed at a discounted rate; surfaced on the dashboard as savings.
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cost_cents          INTEGER NOT NULL DEFAULT 0,     -- cost in USD cents (integer for ledger safety)
    cost_micro_cents    INTEGER NOT NULL DEFAULT 0,     -- sub-cent precision (1 cent = 1000 micro_cents)
    latency_ms          INTEGER,
    status              TEXT NOT NULL DEFAULT 'success', -- 'success', 'error', 'budget_exceeded', 'loop_detected', 'timeout'
    error               TEXT,
    -- Fingerprint: short hash of (project, model, head of last user msg, tools).
    -- Rows with the same fingerprint that fire in a short window look like an
    -- agent loop. Nullable so legacy rows (before Phase 2) remain valid.
    fingerprint         TEXT,
    -- If the semantic router rewrote `model`, the pre-rewrite value lives here.
    -- NULL means the caller's requested model was sent through as-is.
    original_model      TEXT,
    request_body        JSONB NOT NULL,                 -- full request as received by gateway
    response_body       JSONB,                          -- full upstream response (null on error)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requests_project_created ON requests(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_fingerprint ON requests(fingerprint, created_at DESC);

-- Alert rules: per-project subscriptions for gateway events. On matching
-- events (budget_exceeded, loop_detected, ...), the gateway POSTs a JSON
-- payload to `webhook_url` and/or delivers to `email` (email delivery is
-- logged-only in v0; Resend/SMTP integration comes later).
CREATE TABLE IF NOT EXISTS alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,        -- 'budget_exceeded' | 'loop_detected'
    webhook_url     TEXT,
    email           TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_project_event
    ON alert_rules(project_id, event_type) WHERE enabled = TRUE;

-- Routing rules: per-project recipes for the semantic router. When an
-- incoming request's complexity score drops below `threshold` AND its model
-- matches `from_pattern`, the gateway rewrites the model to `to_model`
-- before forwarding upstream. The original model is preserved on the
-- resulting `requests` row in `original_model` for audit + savings math.
CREATE TABLE IF NOT EXISTS routing_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    threshold       REAL NOT NULL DEFAULT 0.3,          -- 0..1; below = cheap-route
    from_pattern    TEXT NOT NULL,                      -- JS regex on model name
    to_model        TEXT NOT NULL,                      -- cheap target model
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, from_pattern)
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_project
    ON routing_rules(project_id, enabled);

-- Budgets: hard caps per project per period.
-- Stored in micro_cents (1 cent = 1000 micro_cents) so sub-cent caps are
-- possible for cheap models. UI still displays $X.XXXX based on this value.
CREATE TABLE IF NOT EXISTS budgets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period              TEXT NOT NULL,                      -- 'daily', 'monthly'
    limit_micro_cents   INTEGER NOT NULL,                   -- hard cap; 1 cent = 1000 micro_cents
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, period)
);

-- Seed: a default project + key for local dev so the gateway works out of the box.
INSERT INTO projects (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default')
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_keys (project_id, key, name)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'tokensmart-dev-key',
    'local-dev'
)
ON CONFLICT (key) DO NOTHING;
