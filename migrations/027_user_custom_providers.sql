-- 027: user-defined custom OpenAI-compatible upstream providers ("L4").
--
-- Background. Until now the gateway only recognized models matching
-- one of the six hard-coded PROVIDER_TEMPLATES (openai, anthropic,
-- deepseek, qwen, doubao). Anything else returned 400
-- `no_template`. That locks users out of Groq, xAI, Mistral direct,
-- self-hosted vLLM / Ollama / TGI, bespoke corporate endpoints, and
-- every niche OpenAI-compatible service that shows up every month.
--
-- With this table an authenticated user can register a custom upstream
-- by (name, base_url, model_prefix) and the gateway's resolveProvider
-- consults it BEFORE the static template list. Works end-to-end for
-- any endpoint that speaks OpenAI's /v1/chat/completions shape;
-- Anthropic-native shape (/v1/messages) requires custom handling and
-- is deliberately out of scope here — those users can still use the
-- built-in `anthropic` provider via BYO-key for Claude.
--
-- Design notes
-- ------------
-- * `model_prefix` is a plain string (not a regex) because we expect
--   users to paste things like `groq/` or `llama-`. Prefix match keeps
--   the UX predictable ("any model starting with this") and the
--   resolver fast. Case-insensitive match done at lookup time.
-- * `encrypted_key` uses the same AES-256-GCM envelope as
--   `user_provider_keys.encrypted_key`, reusing the master key
--   fingerprint machinery for rotation. It's nullable because some
--   custom endpoints (local vLLM on the same LAN, self-auth via
--   mTLS, etc.) don't need a bearer token.
-- * `wire_format` is an extension point — default 'openai_chat' works
--   for 99% of upstreams. Future: 'anthropic_messages', 'google_ai',
--   etc., each with a translator on the gateway side.
-- * Unique (user_id, name) so a UI can address them by human name;
--   we DON'T enforce unique on model_prefix because two custom
--   upstreams might legitimately serve overlapping prefixes (e.g.
--   two Groq accounts on different projects).

CREATE TABLE IF NOT EXISTS user_custom_providers (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Human-readable label shown in the dashboard. 1-64 chars.
    name                    TEXT NOT NULL,
    -- Upstream base URL WITHOUT the /chat/completions suffix, matching
    -- the convention operators already know from `OPENAI_BASE_URL`.
    base_url                TEXT NOT NULL,
    -- Prefix pattern: every incoming model string is lowercased +
    -- prefix-compared against this value. Case-insensitive.
    model_prefix            TEXT NOT NULL,
    -- Same AES-256-GCM envelope format used by user_provider_keys.
    -- NULL = no Authorization header sent.
    encrypted_key           TEXT,
    key_last4               TEXT,
    -- KMS rotation bookkeeping — matches user_provider_keys column.
    master_key_fingerprint  TEXT,
    -- Extension hook for non-OpenAI wire formats. Default 'openai_chat'
    -- means "forward as-is to <base_url>/chat/completions". Future
    -- implementations will translate here.
    wire_format             TEXT NOT NULL DEFAULT 'openai_chat',
    -- Gateway flips this off when a custom provider throws repeatedly
    -- so a broken config doesn't blackhole every request that matches
    -- its prefix. Operator UI lets the user re-enable after fixing.
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Natural key for UI addressability ("edit my-groq").
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_custom_providers_user_name
    ON user_custom_providers (user_id, name);

-- Hot-path lookup: resolveProvider scans a user's custom providers
-- keyed by user_id. Partial index keeps the scan tiny (most users
-- won't have any custom providers).
CREATE INDEX IF NOT EXISTS idx_user_custom_providers_user_enabled
    ON user_custom_providers (user_id)
    WHERE enabled = TRUE;

-- Wire_format enum-ish check. Currently only one value, but written
-- as a CHECK so new values can land via ALTER later without a
-- separate migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'user_custom_providers'
      AND constraint_name = 'user_custom_providers_wire_format_check'
  ) THEN
    BEGIN
      ALTER TABLE user_custom_providers
        ADD CONSTRAINT user_custom_providers_wire_format_check
        CHECK (wire_format IN ('openai_chat'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;
