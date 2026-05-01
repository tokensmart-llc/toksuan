-- 018: Per-user unsubscribe tokens for outbound email lists.
--
-- Problem. Weekly-digest emails today land without a one-click
-- unsubscribe — the footer tells the user to "reply with unsubscribe"
-- which (a) nobody does, (b) CAN-SPAM § 5(a)(5) + GDPR Art. 21(2)
-- both require a clear, functioning opt-out mechanism, and (c) Gmail's
-- bulk-sender policy (Feb 2024) requires `List-Unsubscribe-Post: List-
-- Unsubscribe=One-Click` for senders over 5k msgs/day, which we will
-- eventually cross.
--
-- Fix. Each user gets a stable 256-bit random token the first time we
-- need to mint one; the web unsubscribe endpoint validates the token
-- directly against this column (no signature needed — the token IS
-- the secret). Nullable so backfill is lazy / on-demand in the email
-- send path; unique so token-URL collisions are impossible.
--
-- Reusable across future lists (announcements, incident notices) —
-- the `/unsubscribe?t=<token>&list=<name>` route handler branches on
-- `list=` to flip the right preference column.
--
-- Idempotent: adding the column + index is wrapped so re-runs are
-- no-ops.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'unsubscribe_token'
  ) THEN
    ALTER TABLE users
      ADD COLUMN unsubscribe_token TEXT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_unsubscribe_token
  ON users(unsubscribe_token)
  WHERE unsubscribe_token IS NOT NULL;
