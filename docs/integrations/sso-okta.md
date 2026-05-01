# SAML 2.0 SSO via Okta

Configures Okta to sign your engineers in to TokSuan. Same recipe
works (with field-name adjustments) for Azure AD / Entra, Google
Workspace, JumpCloud, OneLogin, Auth0, Authentik, and KeyCloak — anything
that speaks SAML 2.0.

## Prerequisites

1. A TokSuan **organization** with an **owner** or **admin** role
   for you. Create one at `/organization` if you don't have one yet.
2. An **Okta admin** account with permission to add SAML 2.0
   applications.
3. A verified email domain for your team (e.g. `acme.com`). Your
   engineers will be matched on this domain at sign-in time.

## 1. In TokSuan — gather the SP URLs

Open `/organization/<your-org-id>` and scroll to the **Single sign-on
(SAML 2.0)** card. Copy these two URLs — you'll paste them into Okta:

- **ACS / Reply URL**: `https://YOUR_DASHBOARD_URL/sso/saml/acs?org=<org-id>`
- **Entity ID / SP Metadata**: `https://YOUR_DASHBOARD_URL/sso/saml/metadata?org=<org-id>`

Don't save the form yet — we need the IdP details from Okta first.

## 2. In Okta — create a SAML 2.0 application

1. Okta admin → **Applications** → **Create App Integration** → **SAML 2.0**.
2. Name it `TokSuan`. Logo optional.
3. **SAML Settings**:
   - **Single sign-on URL** = the ACS URL from step 1.
   - **Audience URI (SP Entity ID)** = the Entity ID URL from step 1.
   - **Name ID format**: `EmailAddress`.
   - **Application username**: `Email`.
   - **Attribute Statements** (optional but recommended):
     - `email` ← `user.email`
     - `firstName` ← `user.firstName`
     - `lastName` ← `user.lastName`
4. Finish, then go to **Sign On** → **View SAML setup instructions**.
5. Copy the **Identity Provider metadata** XML block (or download the
   `.xml` file).

## 3. Back in TokSuan — paste the IdP metadata

In the **Single sign-on (SAML 2.0)** card on `/organization/<org-id>`:

- **Enforcement mode**: choose **optional** to keep email-OTP available
  during rollout, or **required** to lock down sign-in to SAML for any
  user whose email matches your domain. **Recommended: start with
  `optional`, flip to `required` once everyone's onboarded.**
- **Email domain**: `acme.com` (no `@`).
- **JIT default role**: what role new users get on first SSO login.
  `viewer` is the safest default (read-only); `member` lets them
  manage projects.
- **IdP metadata XML**: paste the entire XML you copied from Okta.

Click **Save SSO settings**.

## 4. Assign Okta users + smoke-test

1. Okta application → **Assignments** → assign the people who should
   get TokSuan access.
2. From your TokSuan browser session (logged-in as admin), click
   **Test login →** next to the Save button. You should be redirected
   to Okta, accept, and land back on the TokSuan dashboard signed in
   as your Okta identity.
3. Have a teammate sign in:
   - Visit `https://YOUR_DASHBOARD_URL/login`
   - Type their `name@acme.com`
   - On the next click they should be redirected to Okta automatically
     (the email-domain match triggers the SSO route — no OTP email is
     sent).

## What "JIT provisioning" means here

- The first SAML assertion containing a new email address creates the
  TokSuan user account.
- That user is added to your org with the **JIT default role** you
  configured.
- Subsequent logins reuse the existing user; the role is NOT reset on
  every login (so an admin who manually elevated a user keeps their
  elevated role across logins).

## What about deprovisioning?

When you remove a user from the Okta application, they can no longer
sign in (Okta refuses the AuthnRequest). Their TokSuan user row +
membership remain — explicitly remove them from `/organization/<org-id>`
to revoke their session and audit-log the event.

**SCIM 2.0 auto-provisioning + auto-deprovisioning** is on the roadmap
for v0.4. Until then, removal is a two-step process.

## Audit trail

Every SAML event lands in your `/audit` page:

- `auth.sso.login` — successful sign-in with the assertion ID
- `auth.sso.failed` — bad signature, expired assertion, replay attempt,
  or domain-mismatch (with a one-line `reason`)
- `auth.sso.config_updated` — admin changed the IdP config
- `org.member.role_changed` — admin elevated/demoted a member after JIT

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `SAMLResponse parse / signature check failed` | Okta rotated its signing cert; TokSuan still has the old one. | Copy the new metadata XML from Okta and re-paste it. |
| `Assertion email is outside the org's verified domain` | Your IdP issued an assertion for `bob@personal.com` but the org only allows `acme.com`. | Either remove the email-domain restriction on TokSuan or fix Okta's user mapping. |
| `Assertion already used` (replay) | Browser POSTed the same response twice (load-balancer retry, double-click). | Sign in again — Okta will mint a fresh assertion. |
| `Assertion contained no NameID` | Okta SAML profile has NameID format set to "Unspecified" with no value. | Set NameID format to **EmailAddress** in the Okta app config. |
| Browser redirected to `http://localhost:3000` after login | `NEXT_PUBLIC_BASE_URL` is unset in production. | Set it to your real dashboard URL and redeploy. |

## Comparison vs other gateways

| | TokSuan | LiteLLM Proxy | Helicone | Portkey | OpenRouter |
|---|:---:|:---:|:---:|:---:|:---:|
| SAML 2.0 SSO | **✅ Team / Scale** | ❌ | Enterprise tier | Enterprise tier | ❌ |
| Per-org IdP config | ✅ | ❌ | ✅ (Enterprise) | ✅ (Enterprise) | ❌ |
| JIT user provisioning | ✅ | ❌ | ✅ | ✅ | ❌ |
| Required-mode (lock OTP) | ✅ | ❌ | ✅ | ✅ | ❌ |
| Replay protection (assertion-id table) | ✅ | n/a | private | private | n/a |

Open-core means SAML is in the same Apache-2.0 codebase you'd
self-host — it's not gated behind an Enterprise plan.
