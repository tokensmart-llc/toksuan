-- TokenSmart — SQLite single-binary trial schema (v0.3.x)
--
-- Parallel to migrations/001_init.sql + 002 + 005 + 006 + 010, hand-translated
-- to SQLite types and idioms for the in-process bun:sqlite backend used
-- by `install.sh --sqlite`.
--
-- What's intentionally OMITTED vs the Postgres set (these are multi-tenant
-- features that don't belong in a single-binary trial):
--   - users / sessions / magic_links   (no hosted auth)
--   - user_provider_keys + ops_audit_events (no BYO encrypted keys)
--   - audit_events                     (no per-user audit log surface)
--   - referrals_*                      (no Stripe revenue plumbing)
--   - organizations + members + invites (no SAML / RBAC)
--   - shadow_similarity / cache_*      (use Postgres for these)
--
-- What IS here (everything the gateway needs to log requests, enforce
-- budgets, route models, fire alerts, and serve prompt templates):
--   - projects, api_keys, requests, budgets, routing_rules, alert_rules
--   - prompt_templates + prompt_template_versions (so x-ts-template works)
--
-- Type translations (vs Postgres):
--   UUID         → TEXT  (default = gen_random_uuid() registered fn)
--   BOOLEAN      → INTEGER 0/1
--   TIMESTAMPTZ  → TEXT  (ISO8601, default CURRENT_TIMESTAMP)
--   JSONB        → TEXT  (JSON-stringified at write time)
--   REAL         → REAL
--   INTEGER      → INTEGER

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  user_id     TEXT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Plaintext column kept for legacy compatibility with the Postgres
  -- schema; SQLite-mode installs that boot fresh will only see the hash.
  key           TEXT,
  key_hash      TEXT UNIQUE,
  key_prefix    TEXT,
  key_last4     TEXT,
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key      ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS requests (
  id                          TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id                  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  api_key_id                  TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  provider                    TEXT NOT NULL,
  model                       TEXT NOT NULL,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cost_cents                  INTEGER NOT NULL DEFAULT 0,
  cost_micro_cents            INTEGER NOT NULL DEFAULT 0,
  cache_savings_micro_cents   INTEGER NOT NULL DEFAULT 0,
  routing_saving_micro_cents  INTEGER NOT NULL DEFAULT 0,
  latency_ms                  INTEGER,
  status                      TEXT NOT NULL DEFAULT 'success',
  error                       TEXT,
  fingerprint                 TEXT,
  original_model              TEXT,
  streamed                    INTEGER NOT NULL DEFAULT 0,
  request_body                TEXT NOT NULL,
  response_body               TEXT,
  tags                        TEXT NOT NULL DEFAULT '{}',
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_requests_project_created
  ON requests(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_created     ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_model       ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_fingerprint
  ON requests(fingerprint, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id           TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  webhook_url  TEXT,
  email        TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_project_event
  ON alert_rules(project_id, event_type);

CREATE TABLE IF NOT EXISTS routing_rules (
  id                TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  enabled           INTEGER NOT NULL DEFAULT 1,
  threshold         REAL NOT NULL DEFAULT 0.3,
  from_pattern      TEXT NOT NULL,
  to_model          TEXT NOT NULL,
  shadow_to_model   TEXT,
  mode              TEXT NOT NULL DEFAULT 'route',
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, from_pattern)
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_project
  ON routing_rules(project_id);

CREATE TABLE IF NOT EXISTS budgets (
  id                  TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period              TEXT NOT NULL,
  limit_micro_cents   INTEGER NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, period)
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id               TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  current_version  INTEGER NOT NULL DEFAULT 1,
  description      TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_project
  ON prompt_templates(project_id, name);

CREATE TABLE IF NOT EXISTS prompt_template_versions (
  id                  TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  template_id         TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  body                TEXT NOT NULL,
  note                TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_template
  ON prompt_template_versions(template_id, version DESC);

-- Seed: a default project + key for local dev so the gateway works out
-- of the box. Same identifiers as the Postgres seed so demos are
-- portable across backends.
INSERT INTO projects (id, name)
  SELECT '00000000-0000-0000-0000-000000000001', 'default'
  WHERE NOT EXISTS (
    SELECT 1 FROM projects WHERE id = '00000000-0000-0000-0000-000000000001'
  );

-- Plaintext seed (legacy column) — `findApiKey()` opportunistically
-- backfills key_hash + prefix + last4 on first lookup, mirroring the
-- behavior on Postgres-mode upgrades from v0.0.1 → v0.0.2.
INSERT INTO api_keys (project_id, key, name)
  SELECT
    '00000000-0000-0000-0000-000000000001',
    'tokensmart-dev-key',
    'local-dev'
  WHERE NOT EXISTS (
    SELECT 1 FROM api_keys WHERE key = 'tokensmart-dev-key'
  );
