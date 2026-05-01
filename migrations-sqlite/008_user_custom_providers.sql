-- 008 (SQLite): mirror migrations/027_user_custom_providers.sql.
--
-- See Postgres copy for rationale. SQLite shim is for single-node dev
-- installs; multi-tenant BYO / custom-provider features still work
-- there, just without the ON DELETE CASCADE guarantees Postgres gives
-- (SQLite honors FKs when `PRAGMA foreign_keys = ON`, set by the shim
-- at boot).

CREATE TABLE IF NOT EXISTS user_custom_providers (
    id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                    TEXT NOT NULL,
    base_url                TEXT NOT NULL,
    model_prefix            TEXT NOT NULL,
    encrypted_key           TEXT,
    key_last4               TEXT,
    master_key_fingerprint  TEXT,
    wire_format             TEXT NOT NULL DEFAULT 'openai_chat' CHECK (wire_format IN ('openai_chat')),
    enabled                 INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_custom_providers_user_name
    ON user_custom_providers (user_id, name);

CREATE INDEX IF NOT EXISTS idx_user_custom_providers_user_enabled
    ON user_custom_providers (user_id)
    WHERE enabled = 1;
