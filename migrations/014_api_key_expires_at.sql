-- TokenSmart — soft-rotate grace period for API keys (v0.4.x)
--
-- Before this migration, "rotate key" was atomic: the old key stopped
-- working the instant the new one was minted. That's fine for a
-- copy-paste-friendly one-box dev, but in production a typical rotate
-- flow needs a brief overlap so an in-flight deploy can swap secrets
-- without anyone getting 401.
--
-- Design:
--   - `expires_at` NULL = the key is canonical / never expires (same
--     semantics as v0.3 and before).
--   - `expires_at` non-NULL = the key is in soft-rotate grace mode.
--     The gateway accepts it until `NOW() >= expires_at`, at which
--     point findApiKey treats it as invalid.
--   - A background sweep (or lazy cleanup on read) hard-deletes rows
--     where `expires_at < NOW()`. We don't bother with that step on a
--     per-request basis — carrying a 24h-old expired row is cheap.
--
-- No data migration needed: every existing row stays NULL and behaves
-- exactly as it did pre-migration. The column is indexed for the
-- `expires_at < NOW()` predicate so the sweep job is a fast index
-- range scan rather than a seq-scan of the whole api_keys table.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at
  ON api_keys(expires_at)
  WHERE expires_at IS NOT NULL;
