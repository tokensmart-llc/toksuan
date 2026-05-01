# Sub-processors

TokSuan's hosted services (`tokensmt.com`, `gateway.tokensmt.com`) use the third-party
sub-processors listed below. **Self-hosted deployments use none of these by default** — the
operator chooses their own.

This list is the authoritative source. Customers signing the [DPA](dpa-template.md) authorize
the sub-processors below as of the date of signing. New sub-processors are added with at
least 30 days' advance notice.

---

## Current sub-processors

| Sub-processor | Service category | Data processed | Region | Justification |
|---|---|---|---|---|
| **Amazon Web Services, Inc.** | Cloud hosting (compute, Postgres, KMS) | Everything in `requests`, `audit_events`, `users`, `user_provider_keys` | United States (us-east-1 primary) | Primary infrastructure |
| **Stripe, Inc.** | Payment processing | Customer email, plan tier, subscription identifiers (no card data — Stripe holds it directly) | United States | Billing |
| **Resend, Inc.** | Transactional email (auth) | Recipient email + 6-digit OTP / magic-link URL | United States | Auth email delivery |
| **Cloudflare, Inc.** | DNS + DDoS protection (network only — no data inspected) | DNS queries, request metadata | Global | Network infrastructure |

---

## Sub-processors evaluated but **not** in use

We've evaluated and explicitly chosen *not* to use these (yet):

- **Google Cloud Platform** — supported as an alternative KMS provider in code, not currently used in hosted production
- **Vercel** — dashboard could be hosted there; today we self-host on AWS for data-locality
- **Datadog / New Relic / Sentry** — application monitoring; today we use AWS CloudWatch + structured logs only
- **Segment / Mixpanel / Amplitude** — product analytics; we send no customer data to any of these. We have no analytics on the dashboard at all.

If a customer engagement requires a sub-processor on this evaluated list, we'll discuss
on a case-by-case basis.

---

## Notification of new sub-processors

Customers who have signed a DPA receive **30 days' advance notice** of new sub-processors
via the email on file. The customer may object in writing within that 30-day window; we'll
work with them to find an alternative arrangement, or — if no resolution is possible —
allow termination of the affected service portion without penalty.

---

## Self-host

If you self-host TokSuan, no TokSuan sub-processor receives any of your data. You
choose your own:

- Cloud / hardware host
- Database hosting (Postgres anywhere — RDS, Supabase, your own VM, etc.)
- KMS provider (AWS, GCP, or env-master-key)
- Email service for OTP (Resend, Postmark, AWS SES, Mailgun — anything with an SMTP / API)
- Payment processor if you resell (Stripe, Paddle, etc.)

The TokSuan codebase has no telemetry. There is no "phone home". We literally do not
know you exist unless you tell us.

---

## Last updated

2026-04-22
