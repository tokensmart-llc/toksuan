# Security

This document describes TokSuan's security posture. Threats, encryption, vulnerability
disclosure, and what we explicitly do **not** do with your data.

For commercial / enterprise customers who need a Data Processing Addendum, see
[`docs/trust/dpa-template.md`](docs/trust/dpa-template.md).

---

## Threat model

TokSuan sits between your application and your LLM provider. The data flowing through it is:

| Data class | Sensitivity | How we handle it |
|---|---|---|
| **Customer prompts (`request_body`)** | Often contains PII, source code, business logic | Stored in Postgres `requests.request_body` JSONB. Encrypt-at-rest is the operator's responsibility (Postgres TLS + disk encryption). Never sent to third parties. |
| **LLM responses (`response_body`)** | Same as above | Same handling. For SSE streams we store a compact summary instead of the full reconstructed text to limit DB bloat. |
| **TokSuan API keys (`ts_…`)** | Bearer credential | SHA-256 hashed at rest. Plaintext shown **once** at creation via 120s HTTP-only cookie that the project page consumes-and-clears. Plaintext is never logged or persisted. |
| **Upstream provider keys** (BYO: OpenAI / Anthropic / etc.) | High-value secrets | AES-256-GCM encrypted with envelope encryption. Per-row random DEK wrapped by AWS or GCP KMS CMK. Master keys never leave KMS. DEK plaintext is held in process for at most one request and then `.fill(0)`'d. |
| **Auth sessions** | Cookie-based | HTTP-only cookies, 30-day TTL by default. No JWTs (no client-side validation surface). |
| **Audit logs (`audit_events`, `ops_audit_events`)** | Append-only | Stored in Postgres, indexed by user. Never deleted programmatically. |
| **Email addresses** | Per privacy regs | Stored in Postgres, used for OTP / magic-link delivery via Resend. |

---

## Encryption posture

### TokSuan API keys

- Hashed with SHA-256 (`api_keys.key_hash`)
- First 7 chars + last 4 stored in cleartext for display (`key_prefix`, `key_last4`)
- Plaintext shown to the user **once** at creation via a 120s HTTP-only cookie
- Lookup is O(1) via the indexed `key_hash` column

### Upstream provider (BYO) keys

Three deployment modes, picked at startup:

| Mode | When to use | Master key location | Per-row crypto |
|---|---|---|---|
| **Env-master-key** | Self-hosted single-tenant dev | `TOKENSMART_PROVIDER_KEY_ENCRYPTION` env var (32 bytes hex/base64) | AES-256-GCM directly with the master key |
| **AWS KMS envelope** | Hosted production on AWS | AWS KMS CMK (master key never leaves KMS) | Per-row random 256-bit DEK, wrapped by KMS CMK via `GenerateDataKey`. Stored as `base64(magic||dek_len||wrapped_dek||iv||ct||tag)` |
| **GCP KMS envelope** | Hosted production on GCP | GCP KMS CMK (master key never leaves KMS) | Same envelope format as AWS, DEK generated locally and wrapped via `kms.encrypt` |

Minimum AWS IAM:

```json
{ "Effect": "Allow",
  "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
  "Resource": "arn:aws:kms:REGION:ACCOUNT:key/CMK-ID" }
```

Note: `kms:Encrypt` is **not** required — envelope encryption uses `GenerateDataKey` instead.
Excluding `kms:Encrypt` reduces blast radius if a credential leaks.

### Master-key fingerprints

Every encrypted row carries a `master_key_fingerprint` (8 hex chars from `sha256(master_or_kms_key_id)`).
This enables:

- **Mismatch detection** — wrong master key → loud error per request, not silent fallback
- **Rotation** — `bun run rotate-master-key` re-encrypts every row OLD→NEW in one transaction, idempotent
- **KMS migration** — `bun run migrate-to-kms` sweeps env-era rows to KMS, dual-backend reads work mid-migration

### DEK cache

Decrypted DEKs are held in an LRU cache (default 10 min TTL, 1000 entries). Disable with
`TOKENSMART_KMS_CACHE_TTL_MS=0` for ultra-paranoid compliance contexts.

---

## What we don't do with your data

- ❌ **No phone-home telemetry by default**. Self-hosted TokSuan never sends anything to TokSuan hosted services unless the operator explicitly opts in. Operators can choose to send anonymous, privacy-thresholded daily aggregates by setting `TOKENSMART_ANON_TELEMETRY=1` and running `bun run send-anon-telemetry`. The sender never uploads prompts, responses, request bodies, provider keys, user emails, project names, request IDs, or exact per-request timestamps. See [`docs/trust/open-source-boundary.md`](docs/trust/open-source-boundary.md) for details.
- ❌ **No model training**. Your prompts are never used to train any model.
- ❌ **No third-party sharing**. Hosted TokSuan shares prompts only with the upstream LLM provider you chose (OpenAI, Anthropic, etc.) when forwarding the request.
- ❌ **No spread on tokens**. We don't see your provider invoice. You BYO provider key, your provider bills you.
- ❌ **No retention beyond what you configure**. The `requests` table retains everything until you delete it. Retention policies are the operator's responsibility — see "Data retention" below.

---

## Data retention

This section is referenced by our DPA (`docs/trust/dpa-template.md` §7
and Annex 2) — the table below is the single source of truth for both
documents. Two different retention regimes apply depending on where
TokSuan is running:

### Hosted SaaS (tokensmt.com)

We store the following data types for the following durations by default.
Customers can request deletion at any time from the dashboard; requested
deletions land within
**30 days** (typically sub-24h — the 30d window is the DPA-level
commitment, not the steady-state target).

| Data type | Retention | Deleted on customer request? | Deleted on account closure? |
|---|---|---|---|
| `requests` (prompt + response bodies, cost, status) | **90 days rolling** | Yes | Yes, within 30 days |
| `audit_events` (auth, key, billing events) | **3 years** (SOC-2 minimum) | On dashboard request only | Yes, within 30 days |
| `ab_results` (shadow A/B experiment outcomes) | **90 days rolling** | Yes | Yes, within 30 days |
| `user_provider_keys` (BYO upstream keys, AES-256-GCM at rest) | Until customer removes it | Yes, immediate | Yes, immediate |
| `users` / `sessions` / `organizations` | Until account closure | On dashboard request | Yes, within 30 days |
| Stripe customer + subscription records | Held by Stripe; mirrored locally for ID lookup | Stripe's retention applies | Local mirror deleted within 30 days; Stripe's independent retention (7yr tax minimum in most jurisdictions) is outside our control |
| Backups (Postgres PITR window) | **30 days** | Purged on next rolling window | Purged on next rolling window |

The 90-day rolling window on `requests` / `ab_results` is implemented
by a scheduled job — `bun run sweep-old-requests` (see
`apps/dashboard/scripts/sweep-old-requests.ts`). Hosted tokensmt.com
schedules this run; self-hosters wire the same script to their preferred
scheduler (host crontab, GitHub Actions, Fly Machines schedule, Kubernetes
CronJob, etc.). The window is configurable via
`TOKENSMART_REQUEST_RETENTION_DAYS`; hosted tokensmt.com uses 90. Every
run writes a `request.retention_sweep` row to `ops_audit_events` with the
eligible / deleted row counts — that's the forensic trail for any DPA /
SOC-2 review.

If a customer asks for a longer window (e.g. they want 12 months for
their own forensics), that's a contract-level override and we'll
quote an infra upcharge per our DPA §7.

### Self-host (Apache-2.0, your infrastructure)

There is no automatic deletion — you are the operator, you own the
retention policy. The defaults shipped in the repo are "keep
everything forever", which is fine for dev / small teams but a
compliance anti-pattern at any real scale. Common patterns:

- **`pg_cron` job** to truncate `requests` older than 90 days
- **Quarterly manual archive + purge** of `audit_events`
- **Manual BYO-key removal** via the dashboard when rotating IdP

To purge a single project's data (hosted + self-host):

```sql
DELETE FROM requests WHERE project_id = 'PROJECT_UUID';
DELETE FROM ab_results WHERE project_id = 'PROJECT_UUID';
DELETE FROM audit_events WHERE project_id = 'PROJECT_UUID';
DELETE FROM api_keys WHERE project_id = 'PROJECT_UUID';
DELETE FROM budgets WHERE project_id = 'PROJECT_UUID';
DELETE FROM routing_rules WHERE project_id = 'PROJECT_UUID';
DELETE FROM alert_rules WHERE project_id = 'PROJECT_UUID';
DELETE FROM projects WHERE id = 'PROJECT_UUID';
```

Use the dashboard self-serve export and deletion controls for account data
requests. That dashboard path is the SLA-committed channel.

---

## Reporting a vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting flow:

https://github.com/tokensmart-llc/toksuan/security/advisories/new

Include:

- A clear description of the vulnerability
- Steps to reproduce
- Affected version (commit SHA preferred)
- Your name + email if you'd like credit

We aim to respond within **3 business days** and to patch + disclose within **30 days** of
confirmation. Severe vulnerabilities (RCE, auth bypass, plaintext key exposure) are prioritized
within 24 hours.

We **welcome** responsible disclosure. There is no bug bounty in cash today, but disclosed
researchers get:

- Public credit in `CHANGELOG.md` (opt-in)
- A private "Security disclosed" badge on hosted TokSuan accounts (opt-in)
- A handwritten thank-you email from the founder (always)

---

## Hosted-only: sub-processors

The hosted product (gateway.tokensmt.com / tokensmt.com) uses these sub-processors. Self-hosted
deployments use none of them by default.

| Sub-processor | Purpose | Data sent |
|---|---|---|
| AWS / GCP (one of) | Postgres + container hosting + KMS | Everything in the threat-model table above |
| Stripe | Billing | Email + plan tier + Stripe customer/subscription IDs |
| Resend | Auth email delivery | Email address + 6-digit OTP / magic-link URL |

Full list and roles in [`docs/trust/sub-processors.md`](docs/trust/sub-processors.md).

---

## Reliability posture

**TokSuan does not currently offer a formal SLA.** This is deliberate, not an oversight.

We're a small team (founder + partner). Promising 99.9% uptime would require multi-region
replication, automated failover, and a 24/7 on-call rotation we don't have today. Writing
99.9% on a marketing page when we know we can't honestly hit it is the kind of dishonesty
that erodes trust the moment a real incident happens.

**What we do today:**

- **No public status page yet** — building one before we have hosted customers would be a $30/month commitment with nothing to report. We'll stand one up alongside our public hosted launch (target: late 2026 / Q4). In the meantime, hosted incidents are communicated via direct email to affected accounts and posted as [public GitHub issues](https://github.com/tokensmart-llc/toksuan/issues/new/choose).
- **Operating goal today**: < 1 hour of TokSuan-attributable downtime per month (~99.86%). This is what we operate against; it is not a contractual SLA.
- **Transparent post-mortems** — for any incident lasting > 30 minutes we publish a write-up within 7 days (today: GitHub issues; later: dedicated status page)
- **Cross-provider failover built into the gateway** ([`TOKENSMART_FAILOVER_MAP`](../apps/gateway/.env.example)) so an upstream LLM provider outage doesn't take you down with us
- **Self-host is always an option** — the [Apache-2.0 license](LICENSE) means you can run TokSuan in your own infrastructure under whatever uptime regime you maintain. Many enterprises do exactly this.

**When we will introduce a formal SLA:**

- $10k MRR + multi-region deployment (target Q4 2026 / Q1 2027)
- Initial commitment: 99.5% monthly, excluding (a) upstream LLM provider unavailability, (b) cloud infrastructure provider unavailability, (c) scheduled maintenance windows of <30 min announced 7+ days ahead
- Credit formula: 10% of next-month subscription per 0.1% missed, capped at 100%

**If reliability is a procurement blocker for you today:** self-host. Same code, your
infra, your SLO. Start a GitHub issue if you want to talk through the architecture.

---

## Refunds and cancellation

**We don't offer refunds.** Instead, the subscription is monthly and you can cancel any
time via the Stripe customer portal. Cancellations take effect at the end of the current
billing period.

The maximum you ever risk is **one month's subscription** ($29 Pro, $99 Team) for the
period you actually used. If TokSuan isn't saving you more than the subscription
fee, cancel — no questions, no exit interview, no clawback.

We deliberately don't do "30-day money-back guarantees" because they invite gaming
(subscribe → use heavily → refund) and operational pain (chargebacks, dispute fees,
disputes between accounting cycles). Monthly billing + instant cancellation gives you
the same protection without the friction.

---

## Compliance roadmap

This is the honest current state, not aspiration:

| | Status | Notes |
|---|---|---|
| **GDPR-aligned data handling** | ✅ Today | DPA template available; data subject rights honored on request |
| **SOC 2 Type 1** | 🟡 Targeted Q4 2026 | Once hosted MRR justifies the audit cost (~$15–25k) |
| **SOC 2 Type 2** | 🟡 Targeted 2027 | After 12 months of Type 1 controls |
| **HIPAA BAA** | ❌ Not pursued | Out of scope for v1; will reconsider if a healthcare customer commits |
| **ISO 27001** | ❌ Not pursued | Same as HIPAA |

If your procurement requires SOC 2 today, **self-host TokSuan and run it in your own
SOC-2-certified environment**. The Apache-2.0 license + open codebase makes this straightforward.
