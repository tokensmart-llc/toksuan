# Data Processing Addendum (TEMPLATE)

> **This is a template. It is not legal advice.** Have your counsel review before signing
> anything that references this document. TokenSmart LLC makes no warranty as to the legal
> sufficiency of this template in your jurisdiction.

This Data Processing Addendum (**"DPA"**) forms part of the agreement between
**TokenSmart LLC** ("TokSuan", "Processor") and the customer identified in the order
form ("Customer", "Controller") for the use of TokSuan's hosted services
(`tokensmt.com`, `gateway.tokensmt.com`).

For self-hosted deployments of the open-source TokSuan software, **TokSuan is not a
data processor** — the deploying organization is both controller and processor of its own
data. This DPA does not apply.

---

## 1. Definitions

Terms not defined here have the meaning given in GDPR (Regulation (EU) 2016/679) or
applicable equivalent privacy law.

| Term | Meaning |
|---|---|
| **Customer Data** | Any data Customer (or its end users) sends through, or stores via, the hosted TokSuan services. Includes prompts, completions, API keys (TokSuan-issued and BYO upstream provider), usage logs, audit logs. |
| **Sub-processor** | A third party engaged by TokSuan to process Customer Data on TokSuan's behalf. Current list in [`docs/trust/sub-processors.md`](sub-processors.md). |
| **Data Subject** | An identified or identifiable natural person to whom Customer Data relates. |

---

## 2. Roles

- **Controller**: Customer
- **Processor**: TokenSmart LLC
- **Sub-processors**: As listed in `docs/trust/sub-processors.md`. Customer authorizes use of these on signature of this DPA.

---

## 3. Scope and purpose of processing

### 3.1 Subject matter
TokSuan provides an AI spend control plane and dashboard service. Processing consists of receiving
LLM API requests, recording metadata + (optionally) request/response bodies, forwarding
the requests to the upstream LLM provider Customer has authorized, returning responses,
and rendering analytics.

### 3.2 Duration
For the term of the underlying agreement, plus retention periods specified in section 7.

### 3.3 Nature
Storage, transmission, analysis, encryption, decryption.

### 3.4 Categories of data subjects
End users of Customer's applications. (TokSuan has no direct relationship with these
data subjects.)

### 3.5 Categories of personal data
Whatever Customer chooses to send through TokSuan. Commonly includes:

- Prompt text (which may include names, emails, code, business context)
- LLM responses
- Authentication identifiers (Customer's TokSuan user account email)
- IP addresses (audit log)

TokSuan does not require or solicit special-category personal data (Article 9 GDPR).
Customer should not send special-category data through TokSuan unless they have
established the appropriate legal basis themselves.

---

## 4. TokSuan's obligations

### 4.1 Documented instructions
TokSuan processes Customer Data only on Customer's documented instructions, including
those reflected in the agreement and this DPA. Configuration changes Customer makes via
the dashboard (budgets, routing, alerts) constitute documented instructions.

### 4.2 Confidentiality
All TokSuan personnel with access to Customer Data are under written confidentiality
obligations.

### 4.3 Security
TokSuan implements technical and organizational measures appropriate to the risk,
including:

- **Encryption at rest** for upstream provider keys: AES-256-GCM with envelope encryption (per-row random DEK wrapped by AWS or GCP KMS Customer Master Key)
- **Encryption in transit**: TLS 1.2+ for all connections (browser → dashboard, dashboard ↔ gateway, gateway → upstream LLM provider)
- **Authentication**: Email + 6-digit OTP + magic link, HTTP-only session cookies
- **API key handling**: SHA-256 hashed at rest, plaintext shown to user once via 120-second consume-and-clear cookie
- **Audit logging**: All authentication events, API key actions, billing events, and configuration changes logged with IP and User Agent
- **Access controls**: Sub-processor (cloud provider) IAM roles scoped to least privilege
- **Vulnerability disclosure**: Per [`SECURITY.md`](../../SECURITY.md), GitHub private vulnerability reporting

### 4.4 Sub-processors
TokSuan will:

- Maintain the public sub-processor list at [`docs/trust/sub-processors.md`](sub-processors.md)
- Notify Customer at least 30 days before adding a new sub-processor
- Honor Customer's reasonable objection to a new sub-processor by either resolving the objection or, failing that, allowing Customer to terminate the affected service portion

### 4.5 Data subject rights
TokSuan will assist Customer in responding to data subject requests (access, rectification,
erasure, portability, restriction, objection) by:

- Providing tools to query/export/delete Customer Data via the dashboard
- Responding to assistance requests within 7 business days

### 4.6 Personal data breach notification
TokSuan will notify Customer without undue delay (and in any case within 72 hours) of
becoming aware of a Personal Data Breach affecting Customer Data.

### 4.7 Data Protection Impact Assessments
TokSuan will provide reasonable assistance to Customer in conducting DPIAs and prior
consultations with supervisory authorities.

### 4.8 Audit
Customer may, no more than once per calendar year and upon at least 30 days' written notice,
request reasonable evidence of TokSuan's compliance with this DPA. TokSuan will
provide responses to written questionnaires and (when available) third-party audit reports
(e.g. SOC 2). On-site audits are not granted by default and require a separately negotiated
agreement.

---

## 5. International data transfers

Customer Data may be processed by TokSuan in the United States or any region where its
sub-processors operate. Transfers from the EEA / UK / Switzerland to the United States are
governed by:

- The EU Standard Contractual Clauses (Module 2: Controller to Processor) as approved by
  the European Commission Implementing Decision (EU) 2021/914, incorporated by reference
- The UK International Data Transfer Addendum to the EU SCCs
- The Swiss-specific adaptations as required by the Swiss Federal Data Protection and
  Information Commissioner

The SCCs are deemed signed upon execution of this DPA.

---

## 6. Customer obligations

Customer warrants that:

- It has obtained all necessary consents, established the appropriate legal basis, and
  provided all required notices to data subjects whose data Customer sends through TokSuan
- It will not send special-category personal data, payment card data, or other categories
  outside TokSuan's documented capabilities without first obtaining TokSuan's written
  agreement
- It is responsible for the legality of the LLM use cases for which it employs TokSuan

---

## 7. Retention and deletion

### 7.1 Canonical retention table
Per-data-type retention periods, on-request deletion SLAs, and behavior
on account closure are all enumerated in the retention table at
[`SECURITY.md` § Data retention](../../SECURITY.md#data-retention).
That table is the single source of truth; this section refers to it so
updates land in one place.

Summary (see the linked table for full detail):

- **Request / A/B bodies**: 90 days rolling
- **Audit events**: 3 years (SOC-2 minimum), deletable on written request
- **BYO provider keys** (`user_provider_keys`, AES-256-GCM at rest):
  retained until the customer removes them; deleted immediately on
  customer request
- **User + organization metadata**: retained until account closure
- **Postgres point-in-time-recovery backups**: 30 days

### 7.2 On termination
Customer may export or request deletion of Customer Data at any time
via the dashboard.

Within **30 days** of termination, TokSuan will delete or return all
Customer Data enumerated in § 7.1, except for:

- **Audit events**, which are retained for 3 years (SOC-2 minimum) with
  processing limited to compliance / security review purposes
- **Billing records** (invoices, tax documents), which are retained
  for **7 years** to meet accounting and tax-law obligations
- Any other data where retention is required by applicable law (in
  which case TokSuan will preserve confidentiality and cease all
  other processing)

### 7.3 Mirrored Stripe data
The local mirror of Stripe customer + subscription records is deleted
within 30 days of termination. Stripe retains its own copy under its
independent retention policies (typically 7+ years for tax purposes) —
contact Stripe directly for data-subject requests against their copy.

### 7.4 Self-hosted deployments
This section (and this DPA generally) applies only to the TokSuan
hosted SaaS at tokensmt.com. Self-hosted Apache-2.0 deployments have
no retention or deletion commitment from TokSuan because we do not
process the data — the Customer operating the self-hosted stack is
simultaneously the Controller and the Processor. See
[`SECURITY.md` § Data retention](../../SECURITY.md#data-retention)
"Self-host" sub-section for guidance.

---

## 8. Liability

The liability provisions of the underlying agreement apply to this DPA. Nothing in this
DPA expands TokSuan's liability beyond those provisions.

---

## 9. Term, conflicts, and miscellaneous

### 9.1 Term
This DPA is effective from the date both parties sign and continues for the duration of
the underlying agreement.

### 9.2 Conflicts
In case of conflict between this DPA and the underlying agreement, this DPA prevails for
matters of personal data processing.

### 9.3 Governing law
The laws of the State of Delaware, USA, govern this DPA, except where overridden by
mandatory data protection law (in which case the relevant data protection law applies to
the data protection question only).

### 9.4 Severability
If any provision is held unenforceable, the rest remains in effect.

---

## Signatures

| | TokenSmart LLC | Customer |
|---|---|---|
| Name | | |
| Title | | |
| Date | | |
| Signature | | |

---

## Annex 1 — Sub-processors

See live list at [`docs/trust/sub-processors.md`](sub-processors.md).

## Annex 2 — Technical and Organizational Measures

See [`SECURITY.md`](../../SECURITY.md), particularly the "Encryption posture" and
"Threat model" sections.
