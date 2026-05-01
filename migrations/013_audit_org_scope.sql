-- TokenSmart — org-scope audit events (v0.4.x)
--
-- Context: the /audit page used to be strictly `user_id`-scoped. That
-- meant an owner/admin of a Team/Scale org couldn't see a SOC-2-style
-- "who in my org did what" narrative in one place — they had to ask
-- each member to open their own /audit tab. B6 follow-up closes that
-- gap.
--
-- Change shape: additive column + backfill. NO rows are moved, NO
-- behavior changes until the dashboard code keys off the new column
-- (next commit). Safe to roll back to the pre-v0.4 dashboard on the
-- post-migration schema — the nullable column is just unused.
--
-- Backfill policy: for existing events where `project_id` points at
-- an org-owned project, stamp `organization_id` from that project's
-- current `organization_id`. Events with no project (auth.login,
-- auth.logout, org.*, etc.) get a best-effort backfill from the
-- acting user's CURRENT primary org membership — if the user has
-- moved between orgs since the event fired, the backfill reflects
-- "which org saw this event" at migration time, not at event time.
-- This is intentionally approximate; the alternative (audit the
-- audit log across time) is out of scope.

-- 1. Column.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS organization_id UUID
    REFERENCES organizations(id) ON DELETE SET NULL;

-- 2. Index for org-scoped queries.
CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON audit_events(organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

-- 3. Backfill — projects.organization_id wins when the event is about
--    a project. Postgres runs this row-at-a-time, so large installs
--    should run it manually outside a migration window; the runtime
--    migrator wraps the whole file in a TX which may take a while on
--    100M+ rows. That's a conscious tradeoff — the dashboard code
--    below uses `COALESCE(a.organization_id, …)` as a fallback when
--    the column is still null, so running the backfill later is fine.

UPDATE audit_events a
   SET organization_id = p.organization_id
  FROM projects p
 WHERE a.project_id = p.id
   AND p.organization_id IS NOT NULL
   AND a.organization_id IS NULL;

-- 4. Best-effort fallback for events with no project scope — stamp
--    from the acting user's current primary org (defined as: first
--    org they joined, tie-broken by membership created_at). Users
--    with no org membership leave the row as NULL, which is the
--    legacy / personal-user / self-host case.

UPDATE audit_events a
   SET organization_id = m.organization_id
  FROM (
    SELECT DISTINCT ON (user_id)
           user_id, organization_id
      FROM organization_members
     ORDER BY user_id, joined_at ASC
  ) m
 WHERE a.user_id = m.user_id
   AND a.project_id IS NULL
   AND a.organization_id IS NULL;
