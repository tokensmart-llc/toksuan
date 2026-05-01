-- TokSuan — Per-user preferred locale (v0.6.x)
--
-- Additive + idempotent. Safe on DBs already past 032.
--
-- Adds `users.preferred_locale TEXT` so the email-sending paths
-- (cron `send-weekly-savings`, organisation invites, OTP emails) can
-- localise email body content without a request context.
--
-- Why on `users` and not a separate `user_preferences` table:
--   - Locale is a one-column attribute that's read on every email
--     send AND on dashboard SSR (already loaded as part of the
--     session). Splitting it into a join table costs more than it
--     saves.
--   - Keeps consistent with the existing one-row-per-user attributes
--     like `weekly_digest_enabled` (migration 008) and
--     `unsubscribe_token` (migration 018).
--
-- Default behaviour:
--   - NULL means "no preference set" → email path falls back to the
--     configured DEFAULT_LOCALE (currently `en`).
--   - UI sets the cookie at login + on toggle; the dashboard's
--     `/api/locale` server action mirrors the cookie value into this
--     column whenever a logged-in user changes locale, so cron
--     senders get a freshly-up-to-date pick.
--
-- Validation:
--   - Plain TEXT, no enum/CHECK constraint. The application layer
--     guards against unsupported codes via `isLocale()`. Adding a
--     CHECK now would force a migration every time we ship a new
--     locale; the application-layer validation is enough.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'preferred_locale'
  ) THEN
    ALTER TABLE users
      ADD COLUMN preferred_locale TEXT;
  END IF;
END$$;

-- No index — `users` rows are read by id (PK) or email (unique idx),
-- and `preferred_locale` is only ever read as part of the row, never
-- as a filter predicate.
