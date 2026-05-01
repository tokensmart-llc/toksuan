-- TokenSmart — Weekly digest email opt-in (v0.2.x)
--
-- Additive + idempotent. Safe on DBs already past 007.
--
-- Adds two columns to `users` for the weekly savings digest email:
--   - weekly_digest_enabled BOOLEAN — explicit opt-in (default FALSE per
--     CAN-SPAM / GDPR best practice; we don't auto-subscribe new users)
--   - weekly_digest_last_sent_at TIMESTAMPTZ — UI shows "last sent X ago",
--     prevents the dashboard from claiming "you'll get an email" when the
--     cron operator hasn't actually been running the script
--
-- The cron sender (`apps/dashboard/scripts/send-weekly-savings.ts`) filters
-- to opt-in users and stamps `last_sent_at` after a successful send.
--
-- Why opt-in not opt-out: cold transactional opt-out is a CAN-SPAM
-- violation in the US and a GDPR issue in EU. Most B2B SaaS use opt-in
-- for non-essential email; we follow the same posture.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'weekly_digest_enabled'
  ) THEN
    ALTER TABLE users
      ADD COLUMN weekly_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'weekly_digest_last_sent_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN weekly_digest_last_sent_at TIMESTAMPTZ;
  END IF;
END$$;

-- Partial index for the cron query "find me users opted in" — small + fast.
CREATE INDEX IF NOT EXISTS idx_users_weekly_digest_enabled
  ON users (id)
  WHERE weekly_digest_enabled = TRUE;
