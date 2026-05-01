-- TokenSmart — self-serve account deletion (v0.4.x)
--
-- Before this, "delete my account" was a written-request-only channel
-- per the DPA. The C1 follow-up adds a UI path: the user marks their
-- own account for deletion, lands in a 30d grace period (matches the
-- DPA §7.2 commitment), and a cron hard-deletes past that window.
--
-- During the grace period the user can cancel with one click. They
-- can still log in, but every page shows a red banner explaining
-- when the hard delete happens.
--
-- Column semantics:
--   deleted_at IS NULL          → active account (default)
--   deleted_at IS NOT NULL      → marked for deletion AT that timestamp
--                                  (NOT "deleted at" — it's the moment
--                                  the request was made; hard-delete
--                                  fires at `deleted_at + 30 days`)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index — we only ever query "who's due for hard-delete?",
-- which reads a tiny minority of rows. Keep the full-users scan fast
-- by not indexing the NULL-dominated active majority.
CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users(deleted_at)
  WHERE deleted_at IS NOT NULL;
