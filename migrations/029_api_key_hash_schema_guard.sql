-- v0.6.x onboarding hardening: make the hashed API-key schema invariant
-- explicit in a fresh append-only migration.
--
-- 002_advanced.sql introduced hashed-at-rest project keys by adding
-- key_hash/key_prefix/key_last4 and making the legacy plaintext `key`
-- column nullable. If an older hosted database missed that ALTER but did
-- receive the dashboard code that inserts hash-only rows, creating the first
-- project API key fails with `null value in column "key" violates not-null`.
--
-- This migration is intentionally idempotent; it restates the required shape
-- so deploys with drift converge before the onboarding server action runs.

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS key_hash    TEXT,
    ADD COLUMN IF NOT EXISTS key_prefix  TEXT,
    ADD COLUMN IF NOT EXISTS key_last4   TEXT;

ALTER TABLE api_keys
    ALTER COLUMN key DROP NOT NULL;

UPDATE api_keys
   SET key_hash = ENCODE(DIGEST(key, 'sha256'), 'hex')
 WHERE key IS NOT NULL AND key_hash IS NULL;

UPDATE api_keys
   SET key_prefix = LEFT(key, 7),
       key_last4  = RIGHT(key, 4)
 WHERE key IS NOT NULL AND key_prefix IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
