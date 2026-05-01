-- TokenSmart — SSO / SAML 2.0 (v0.3.x)
--
-- Adds per-org SAML IdP configuration + the per-user IdP-NameID linkage
-- needed for SP-initiated single sign-on. The org/RBAC chassis from
-- migration 011 (organizations + organization_members + roles) is the
-- foundation this builds on; this migration only wires the IdP fields
-- and JIT-provisioning hooks.
--
-- Library: `samlify` (added to apps/dashboard/package.json). XML
-- signature verification, metadata generation, and assertion consumption
-- live in apps/dashboard/src/lib/saml.ts.
--
-- Endpoints (apps/dashboard/src/app/sso/saml/*):
--   GET  /sso/saml/metadata?org=<id>   → publish SP metadata XML
--   GET  /sso/saml/login?org=<id>&...  → build AuthnRequest, redirect to IdP
--   POST /sso/saml/acs?org=<id>        → consume signed assertion
--
-- Login-flow integration: /login detects when the typed email's domain
-- matches an org's `saml_email_domain` AND that org has saml_enforcement_mode
-- ∈ {'optional', 'required'}; in those cases we redirect to /sso/saml/login
-- instead of mailing an OTP. `'required'` blocks the OTP path entirely;
-- `'optional'` keeps OTP available for fallback.

-- --- 1. Per-org IdP configuration ----------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_enabled'
  ) THEN
    ALTER TABLE organizations
      ADD COLUMN saml_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_idp_metadata_xml'
  ) THEN
    -- Raw XML the org admin pasted (or the URL-fetched copy). We re-parse
    -- it on every login attempt so a key roll on the IdP side is picked
    -- up the next time the admin re-uploads. Storing the XML rather than
    -- only the parsed fields means we never lose fidelity (some IdPs
    -- ship extra extension elements we don't yet read but might later).
    ALTER TABLE organizations
      ADD COLUMN saml_idp_metadata_xml TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_idp_entity_id'
  ) THEN
    -- These three are denormalised out of `saml_idp_metadata_xml` so the
    -- admin can paste fields directly when their IdP doesn't expose a
    -- metadata URL (small or in-house IdPs sometimes don't).
    ALTER TABLE organizations
      ADD COLUMN saml_idp_entity_id TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_idp_sso_url'
  ) THEN
    ALTER TABLE organizations
      ADD COLUMN saml_idp_sso_url TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_idp_x509_cert'
  ) THEN
    -- PEM-encoded signing certificate (or raw base64 — `samlify`
    -- normalises both at parse time).
    ALTER TABLE organizations
      ADD COLUMN saml_idp_x509_cert TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_enforcement_mode'
  ) THEN
    -- 'off'      : feature disabled (default; effectively the v0.2.0 state)
    -- 'optional' : SAML available, OTP still works for the same domain
    -- 'required' : OTP login blocked for users whose email matches the org's
    --              saml_email_domain — they MUST come through the IdP.
    ALTER TABLE organizations
      ADD COLUMN saml_enforcement_mode TEXT NOT NULL DEFAULT 'off'
        CHECK (saml_enforcement_mode IN ('off', 'optional', 'required'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_email_domain'
  ) THEN
    -- The verified email domain (lowercase, no `@`) that triggers the SAML
    -- redirect from /login. UNIQUE because two orgs can't both claim
    -- "acme.com" — we'd silently route some users to the wrong IdP.
    -- Verification (DNS TXT or email-loop) is a future hardening; v0.3
    -- relies on the org admin confirming they own it.
    ALTER TABLE organizations
      ADD COLUMN saml_email_domain TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'saml_default_role'
  ) THEN
    -- Role assigned to JIT-provisioned users coming through this IdP.
    -- Defaults to 'member' — admins can elevate manually after first login.
    -- 'owner' is intentionally excluded from the CHECK so the IdP can
    -- never anoint a new owner via attribute mapping.
    ALTER TABLE organizations
      ADD COLUMN saml_default_role TEXT NOT NULL DEFAULT 'member'
        CHECK (saml_default_role IN ('admin', 'member', 'viewer'));
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_organizations_saml_email_domain
  ON organizations (saml_email_domain)
  WHERE saml_email_domain IS NOT NULL;

-- --- 2. Per-user IdP linkage --------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'sso_subject'
  ) THEN
    -- The IdP's NameID for this user (typically email-format or a
    -- persistent-id format URN). Set on first SSO login. NULL for users
    -- who only ever logged in via OTP.
    --
    -- Composite uniqueness with the org they belong to lives in the
    -- partial index below: a person can be a SAML user in org A and an
    -- OTP user (or different SAML subject) in org B.
    ALTER TABLE users
      ADD COLUMN sso_subject TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'sso_organization_id'
  ) THEN
    -- The org whose IdP minted this user's most recent SSO session.
    -- Lets us look up the right IdP config when refreshing or
    -- single-logout-ing without scanning all orgs.
    ALTER TABLE users
      ADD COLUMN sso_organization_id UUID
        REFERENCES organizations(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'sso_last_login_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN sso_last_login_at TIMESTAMPTZ;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_org_sso_subject
  ON users (sso_organization_id, sso_subject)
  WHERE sso_subject IS NOT NULL AND sso_organization_id IS NOT NULL;

-- --- 3. Replay protection -------------------------------------------------
--
-- Keep a short-window record of consumed SAML assertion IDs to defeat
-- replay attacks. Cleaned up by a periodic prune (any row past
-- `not_on_or_after` is safe to drop). `samlify` handles signature +
-- conditions checks; this is the belt-and-braces "I've already seen this
-- exact assertion id" guard.

CREATE TABLE IF NOT EXISTS saml_consumed_assertions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- The assertion's @ID attribute. Combined with org for uniqueness so
    -- two IdPs that happen to mint colliding IDs don't fight.
    assertion_id    TEXT NOT NULL,
    not_on_or_after TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, assertion_id)
);

CREATE INDEX IF NOT EXISTS idx_saml_consumed_not_on_or_after
  ON saml_consumed_assertions (not_on_or_after);
