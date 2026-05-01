-- TokenSmart — BYO upstream provider keys (v0.0.3)
--
-- Hosted users upload their own OpenAI / Anthropic / etc. credentials via
-- the dashboard. The gateway decrypts them at request time and uses them
-- to forward upstream — no shared-pool billing, no markup confusion, the
-- customer's bill goes straight to their provider account.
--
-- Storage:
--   - `encrypted_key` is base64( IV(12B) || ciphertext || GCM-tag(16B) ),
--     encrypted with AES-256-GCM using a single master key shared between
--     gateway and dashboard via env (TOKENSMART_PROVIDER_KEY_ENCRYPTION).
--   - `key_last4` is plaintext, kept for human display only.
--   - `base_url` is optional — lets a customer point a provider at e.g. a
--     private Azure OpenAI endpoint instead of the public default.
--
-- Migration is additive + idempotent.

CREATE TABLE IF NOT EXISTS user_provider_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Matches the gateway's Provider union: openai | anthropic | deepseek |
    -- qwen | doubao. TEXT instead of an enum so we can add new
    -- providers without an ALTER TYPE.
    provider        TEXT NOT NULL,
    encrypted_key   TEXT NOT NULL,
    base_url        TEXT,
    key_last4       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_provider_keys_user
    ON user_provider_keys(user_id);
