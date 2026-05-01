-- TokenSmart — Organizations + RBAC + multi-seat invitations (v0.2.x)
--
-- Additive + idempotent. Closes Paid-audit gap #3 (Team / Scale "real B2B"):
--   - organizations          : a tenancy boundary larger than a single user
--   - organization_members   : user ↔ org M:N with role
--   - organization_invitations: pending invites with a one-shot token
--
-- Roles (stored as TEXT; no enum so future additions are migration-free):
--   owner   : the user who created the org. Cannot be removed; can transfer.
--   admin   : full read/write on org resources, can invite + change roles
--             except cannot demote/remove the owner.
--   member  : read everything in the org; can mutate per-project resources
--             (budgets, routing, alerts, prompt templates).
--   viewer  : read-only across the org. Can NOT create projects, edit
--             routing, etc. Useful for execs / finance / compliance seats
--             that need numbers but not control.
--
-- Backwards-compat with existing single-tenant `users.id`-owned projects:
--
--   * `projects` gets an OPTIONAL `organization_id`. NULL means
--     "personal project owned by users.id" (legacy + self-hosters).
--     A project can be either user-owned OR org-owned at any time;
--     transferring is a separate UI action that nulls user_id and stamps
--     organization_id (or vice versa).
--   * Visibility: a user can see a project if EITHER:
--       - projects.user_id = user.id  (legacy/personal), OR
--       - projects.organization_id IN (orgs the user is a member of).
--     The dashboard's `getScope()` is the single source of truth for this.
--
-- Hosted-tier alignment (apps/dashboard/src/lib/plans.ts):
--   - Free: 1 personal user, 0 orgs (existing).
--   - Pro:  1 personal user, 0 orgs.
--   - Team: 1 org, up to 5 members (enforced in app, NOT here — keeps the
--           schema ceiling-free so we can adjust pricing without ALTER).
--   - Scale: 1 org, unlimited members.
--
-- SSO/SAML lifecycle:
--   - Each org will eventually carry a `saml_idp_metadata_xml` blob and a
--     `saml_enforcement_mode` (off / optional / required). NOT in this
--     migration to avoid claiming a feature we don't ship.

CREATE TABLE IF NOT EXISTS organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    -- Stable URL-safe slug derived from `name` at creation. Currently
    -- not used in routing but reserved for future /orgs/<slug> URLs.
    slug            TEXT UNIQUE,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_created_by
  ON organizations (created_by_user_id);

CREATE TABLE IF NOT EXISTS organization_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user
  ON organization_members (user_id);

CREATE TABLE IF NOT EXISTS organization_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- Email the invite was sent to. NOT a foreign key to users — we
    -- support inviting people who haven't signed up yet (JIT account
    -- creation on accept).
    email           TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    -- Long random hex token, sent in the invite link. UNIQUE so a leaked
    -- token can be revoked atomically by deleting the row.
    token           TEXT UNIQUE NOT NULL,
    invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    accepted_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_org
  ON organization_invitations (organization_id, email);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email_pending
  ON organization_invitations (email, expires_at)
  WHERE accepted_at IS NULL;

-- Add the optional org pointer to projects. NULL = legacy / personal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'organization_id'
  ) THEN
    ALTER TABLE projects
      ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_projects_organization_id
  ON projects (organization_id)
  WHERE organization_id IS NOT NULL;
