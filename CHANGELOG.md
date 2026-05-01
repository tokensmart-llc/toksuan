# Changelog

All notable changes to TokSuan are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[SemVer](https://semver.org).

This file is the user-facing summary.

---

## [Unreleased] — v0.3 follow-up sprint (2026-04-22)

Picks up the four "honest gaps" from the v0.3 endpoint: SAML, single-binary
SQLite mode, referral cron automation, and prompt-template runtime
substitution. Backwards-compatible — every change is additive.

### Added (v0.3 follow-up)

- **SSO / SAML 2.0 — actual implementation.** Migration `012_sso_saml.sql`
  adds per-org IdP fields (`saml_idp_metadata_xml`, `saml_idp_entity_id`,
  `saml_idp_sso_url`, `saml_idp_x509_cert`, `saml_email_domain`,
  `saml_enforcement_mode` ∈ `off|optional|required`, `saml_default_role`)
  + per-user `sso_subject` + `saml_consumed_assertions` replay-protection
  table. Three SAML routes land:
  - `GET /sso/saml/metadata?org=<id>` — SP metadata XML for IdP-side config
  - `GET /sso/saml/login?org=<id>&next=<path>` — builds AuthnRequest
    (HTTP-Redirect binding) and 302s the browser to the org's IdP
  - `POST /sso/saml/acs?org=<id>` — Assertion Consumer Service: signature
    + audience + replay verification via `samlify`, JIT-provisions the
    user, mints a TokSuan session cookie, redirects to RelayState
  The `/login` page now detects when the typed email's domain matches a
  configured org and short-circuits to SSO; `'required'` mode also
  blocks the OTP fallback. Org admin UI at `/organization/<id>` carries
  a full SSO settings card (paste IdP metadata XML or enter
  entity_id/sso_url/cert manually). Audit log gets `auth.sso.{login,
  failed, config_updated}` events. Live integration guide at
  `docs/integrations/sso-okta.md`.
  - **Closes Paid audit #3 / Team-tier defensibility.**
- **`install.sh --sqlite` single-binary trial mode.** Skips Docker entirely
  — gateway runs against an in-process `bun:sqlite` file. New `sql-driver`
  shim translates the postgres.js tagged-template surface to bun:sqlite at
  query time (rewrites `NOW()` / `INTERVAL` / `DATE_TRUNC` /
  `gen_random_uuid()` / `JSONB` / `::bigint` casts on the fly). Hand-translated
  init schema lives in `migrations-sqlite/001_init.sql`. Multi-tenant
  features (BYO encrypted keys, plan tier caps, semantic cache, anomaly
  monitor, ops-audit log, dashboard) cleanly no-op via `dbBackend`
  feature gates. `/health` reports `backend: "sqlite"`. 12 driver-level
  tests + the full chat pipeline verified end-to-end against `:memory:`
  and a real `data/test.db` file.
  - **Closes OSS audit #2** ("real sqlite-binary fallback") for the
    evaluation/dev path.
- **Referral and digest operator scripts.** Added cron-friendly scripts for
  referral settlement and weekly savings summaries. Hosted scheduling is
  operated outside the open-source runtime; self-host operators can run the
  scripts on their own schedule if they use those surfaces.
- **Prompt template runtime substitution via `x-ts-template`.** Gateway
  loads the template body from `prompt_templates` /
  `prompt_template_versions`, substitutes `{{var}}` Handlebars-style
  placeholders against `body.ts_template_vars` (preferred) +
  `x-ts-template-vars` JSON header (latter wins on key collision), and
  prepends/replaces the system message. Header forms supported:
  `x-ts-template: name`, `name@<int>`, `name@latest`. Each substituted
  request is auto-tagged `template=<name>` + `template_version=<int>` so
  the dashboard's "Spend by tag" card breaks out cost per version with
  no extra schema. Substitution runs BEFORE fingerprinting so loop
  detection sees the expanded prompt. 23 unit tests for parsing +
  rendering + body application; `/projects/[id]/templates` page now
  surfaces a "Use a template at runtime" section with copy-paste curl.

## [Unreleased] — v0.3 sprint (2026-04-22 → 04-23)

Closes the remaining audit gaps from the v0.3 sprint. Six production-grade
features in one push, all with migrations, tests, UI and docs.
Backwards-compatible — every new feature is additive.

### Added

- **One-shot installer** (`./install.sh`):
  - Prereq check (git, openssl, docker, optionally bun), `docker compose up -d` for Postgres + pgweb, generates a 32-byte master encryption key, writes `apps/gateway/.env` + `apps/dashboard/.env.local` with matching values (the #1 footgun for new operators), runs `bun install` in both apps, prints final ready-to-go block with three URLs + sample curl
  - Idempotent — safe to re-run; never overwrites existing env files
  - Flags: `--noninteractive` (CI/Dockerfile), `--skip-deps` (bun-not-installed-yet)
  - `QUICKSTART.md` updated to recommend it as the default path
  - **Closes OSS audit #2** (5-minute install)
- **Referral commission program** (migration `009_referrals.sql`, `apps/dashboard/src/app/referrals/`):
  - Stable per-user `referral_code` (8-char alphanumeric, minted on demand)
  - Middleware captures `?ref=<code>` into a 30-day cookie; first-touch attribution sticks via `referred_by_user_id` set once on signup
  - Stripe `invoice.paid` webhook records a 20% commission row on `referral_credits` (idempotent on `referee_invoice_id`), capped at the first 12 paid invoices per referee
  - `settlePendingReferralCredits` periodic job (operator-triggered today, cron later) mints negative `Stripe.Customers.createBalanceTransaction` entries on the referrer's account
  - `/referrals` UI: stats grid (referees / paying / total earned / pending), credit history table, operator-only "Run settle pass now" button gated on `TOKENSMART_OPS_EMAILS`, program rules section
  - **Closes Paid audit #5** (small hooks)
- **Request replay** (`apps/gateway/src/routes/internal.ts`, `apps/dashboard/src/app/requests/[id]/actions.ts`):
  - New gateway endpoint `POST /internal/replay` authenticated by shared `TOKENSMART_INTERNAL_TOKEN`. Skips API-key auth (we hash on issue, dashboard has no plaintext), skips loop detection + plan caps. Provider resolution honored so BYO keys still apply
  - Re-issues the original request body against a chosen model, writes a new row tagged `replay_of:<orig_id>`, returns the new request id
  - UI: "Replay this request" card on `/requests/[id]` with a model input + datalist of common targets. Auto-redirects to the new request page on success
  - Disabled-by-default — operators must explicitly opt in by setting BOTH `TOKENSMART_INTERNAL_REPLAY_ENABLED=1` and `TOKENSMART_INTERNAL_TOKEN` on the gateway and dashboard. Until both are set, the endpoint returns 503 and the dashboard surfaces a clear setup card.
- **Prompt template registry** (migration `010_prompt_templates.sql`, `apps/dashboard/src/app/projects/[id]/templates/`):
  - Per-project named templates (`prompt_templates`) with append-only version history (`prompt_template_versions`)
  - `current_version` pointer lets you roll back to any older version without losing newer ones
  - UI: list page (`/projects/[id]/templates`) + detail page with active version, append-new-version form, version timeline with one-click "Pin as active", and a danger-zone delete
  - Project-detail page gets a teaser card linking to the template manager
  - URL-safe name validation (`/^[A-Za-z0-9_.-]{1,64}$/`) reserved for the future `x-ts-template: <name>` header
  - **Closes OSS audit functional gap #5c**
- **Semantic prompt cache** (`apps/gateway/src/semantic-cache.ts`, 12 unit tests):
  - In-memory LRU+TTL cache. Master switch via `TOKENSMART_CACHE_ENABLED=1` (default off)
  - Two layers: exact-hash (microsecond lookups, deterministic key from project+model+messages+params) → optional embedding-similarity layer (cosine threshold via `TOKENSMART_CACHE_SIMILARITY_THRESHOLD`, reuses `TOKENSMART_QUALITY_EMBED_MODEL`)
  - Tenant-isolated by project_id namespace
  - Skips streaming, non-zero-temperature, tools, function_call, json_schema, and trivially-short prompts (eligibility gate)
  - Hits land as cost=$0 `requests` rows tagged `cached_by: tokensmart-{exact,similarity}` so they show up in dashboard counts + Spend by tag aggregations
  - Surfaced in `/health` integrations + `/settings → System integrations` row
  - **Closes OSS audit functional gap #5a (vs Helicone "semantic cache")**
- **Organizations + RBAC + multi-seat invitations** (migration `011_organizations_rbac.sql`, `apps/dashboard/src/app/organization/`):
  - `organizations` + `organization_members` (UNIQUE on org+user) + `organization_invitations` (one-shot tokens, 14d TTL)
  - Roles: **owner** (immutable, transfer via separate flow), **admin** (manage members + change roles), **member** (mutate per-project resources), **viewer** (read-only across the org)
  - `getScope()` extended to UNION user-owned + org-shared projects; `userOwnsProject` extended to grant mutation rights to any non-viewer member
  - Email invitations via Resend (with stdout fallback for dev installs that haven't configured email); accept page at `/organization/accept?token=…` with email-mismatch guard
  - `/organization` lists pending-invitations-for-me + my org memberships + create-new-org form
  - `/organization/[id]` shows members table with inline role-change selects, pending invitations table with revoke buttons, invite form, and an SSO/SAML roadmap callout pointing at the existing design doc
  - `apps/dashboard/src/lib/plans.ts` updated: Team feature copy now reflects "Multi-seat orgs + RBAC" and "Up to 5 seats per org"; Scale gets "Unlimited seats per org + RBAC" plus the existing SSO roadmap line
  - **Closes Paid audit #3 (Team B-end essentials) for the RBAC + multi-seat half.**

### Numbers

- Tests: gateway 91/91 passing (was 79/79 at v0.2.0; +12 semantic-cache cases)
- Dashboard: typecheck + production build clean. New routes: `/organization`, `/organization/[id]`, `/organization/accept`, `/projects/[id]/templates`, `/projects/[id]/templates/[templateId]`, `/referrals`
- Migrations: 11 SQL files (was 8; added 009/010/011), all auto-applied at gateway boot

---

## [Unreleased] — v0.2.0 sprint (2026-04-22 late night)

### Added — quick polish (the immediate "do these first" 4)

- **`examples/` directory** with 3 runnable minimal examples: Next.js + Vercel AI SDK chat, LangGraph loop-detector demo, Cursor IDE configuration walkthrough
- **`.github/ISSUE_TEMPLATE/`** — bug / feature / integration templates + PR template + `config.yml` redirecting security/discussion/calculator
- **`/billing` page rewrite** — leads with "no spread on tokens, cancel anytime" instead of feature paywall language; new info card spelling out the four billing principles + link to `/estimate`
- **README first-screen estimator callout** — a blockquote right under the curl example pushes prospective customers to `/estimate` before reading further

### Added — six v0.2.0 features (one SSO/SAML deferred to v0.3.0 with full design sketch)

- **Per-provider multi-key rotation** (`apps/gateway/src/key-rotator.ts` + `providers/{openai,anthropic}.ts`):
  - `OPENAI_API_KEY=sk-1,sk-2,sk-3` is now a 3-key pool; gateway round-robins requests across them
  - On HTTP 429 from upstream, the offending key is benched for a cooldown (default 30s, configurable, respects `Retry-After` header)
  - Single-key envs unchanged — this is fully additive
  - 13 unit tests in `test/key-rotator.test.ts`
- **Weekly savings digest email** (`apps/dashboard/scripts/send-weekly-savings.ts`):
  - One-shot script the operator runs via cron / fly cron / GitHub Actions
  - Per-user 7d savings summary via Resend (route savings + cache savings + top routed pairs + spend total)
  - Skips users with no traffic ("you saved $0!" is just unsubscribe bait)
  - `--dry-run`, `--to=email`, `--min-saved=N` flags for ops control
  - HTML + text email templates in `lib/email.ts`
- **Audit log CSV export** (`apps/dashboard/src/app/audit/export/route.ts`):
  - GET `/audit/export[?limit=N]` returns RFC 4180 CSV download
  - "Export CSV" button added to `/audit` page header
  - Default 5000 rows, max 50000, with `X-TokenSmart-Audit-Rows` header for `curl -I` peeks
  - Filename includes today's date for monthly archive ergonomics
- **Stripe invoice "saved by TokSuan" annotation** (`apps/dashboard/src/lib/stripe.ts` + webhook):
  - `invoice.finalized` webhook handler computes the user's last-period savings, updates the invoice's `footer` + adds a `Saved by TokSuan` custom field
  - Stripe-emailed invoice now reads "TokSuan saved you $X this period via routing + prompt-cache discounts. That's Yx this subscription." reframing the $29/$99 charge as net positive
  - Best-effort + idempotent — invoice still goes out untouched on any error
- **OpenTelemetry trace export** (`apps/gateway/src/otel.ts`):
  - Hand-rolled OTLP/HTTP/JSON exporter (~150 lines, zero new runtime dependencies)
  - One span per chat completion with `gen_ai.*` semantic-convention attributes (model, provider, usage, status) + `tokensmart.*` extensions (project_id, request_id, savings)
  - Compatible with Langfuse Cloud, Honeycomb, Datadog OTel collector, Tempo, Jaeger, Phoenix
  - Disabled by default — set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable
  - Buffered (5s flush interval, 100-span batch); failures dropped after one retry so a degraded backend never backs up the gateway
- **Embedding similarity for shadow A/B trials** (`apps/gateway/src/quality.ts` + migration 007):
  - `ab_results.similarity REAL` column populated from `cosine(embed(primary), embed(shadow))`
  - Set `TOKENSMART_QUALITY_EMBED_MODEL=text-embedding-3-small` to enable; ~$0.0002/trial
  - Quality Proof card on dashboard now shows "Avg semantic similarity 0.92" + "Switch-safe (≥0.85): 84%" instead of just the coarse 2xx-success signal
  - Disabled by default — opt-in for projects that want real quality measurement

### Changed — pricing structure (4-tier + Enterprise + per-tier metered + discounts)

After the v0.2.0 user-perspective audit identified pricing as **structurally broken for $1M ARR path**, this hotfix introduces the full 4-tier ladder with per-tier metered formula, annual billing, and discount programs.

- **`PlanId` extended `"free" | "pro" | "team"` → `"free" | "pro" | "team" | "scale"`** — both `apps/gateway/src/plans.ts` and `apps/dashboard/src/lib/plans.ts` updated in lockstep. `Scale` ($499/mo cap) closes the gap between Team ($99) and Enterprise (custom $1k+) so heavy mid-market customers have somewhere to go without forcing a sales call.
- **Plan limits got a second dimension — monthly request count.** `PlanLimits` now has both `dailyMicroCentsLimit` AND `monthlyRequestLimit`. Free dropped from "$10/day unlimited req" to **"$1/day OR 10k requests/month, whichever first"** — aligns with Helicone/LiteLLM/Portkey's free tier ceiling and forces a real upgrade decision after a meaningful POC. Pro stays at $500/day (no existing-customer downgrade) but gains a 1M req/mo sanity cap. Team and Scale stay unlimited on both axes.
- **`getUserMonthlyRequestCount()` in gateway db.ts** — mirror of `getUserDailyMicroCents` for the new request-count cap. Plan-limit check in `chat.ts` now queries both counters in parallel (single round trip when either cap is enforceable; zero round trips on Team/Scale where both are infinite). Error message tells the user which dimension tripped (`trigger: "daily_spend" | "monthly_requests"` in the 429 response).
- **Annual billing pre-announce** — every paid tier now shows monthly + annual rates (17% off, industry standard). `Plan.priceUsdPerMonthAnnual` field added; new env vars `STRIPE_PRICE_{PRO,TEAM,SCALE}_ANNUAL` for the annual price IDs. The `syncSubscriptionToUser` webhook handler matches against both monthly + annual price IDs so either cadence resolves the same plan.
- **Q3 2026 metered formula now per-tier** — `/billing` page's pre-announce card shows the per-tier breakdown:
  - Pro: `max($9, min(10% × savings, $29))`
  - Team: `max($29, min(10% × savings, $99))`
  - Scale: `max($99, min(12% × savings, $499))` (12% rate captures heavier usage value — Scale customers save more so we share more of it)
- **Enterprise display tier** — synthetic 5th column on the billing page, no Stripe price, "Contact sales" CTA mailing `GitHub Discussions`. Lets procurement-driven buyers see "we have an answer for you" without forcing the founder to maintain a real Enterprise SKU yet.
- **Discount programs** — 17% annual + Free Pro for verified students + Free Pro for OSS maintainers (≥500 stars or CNCF/ASF projects) + 50% off Year 1 for early-stage startups (<$1M raised).
- **README pricing table** — replaced the "Pro $29 / Team $99" sentence with a full 5-row table (Free / Pro / Team / Scale / Enterprise) with per-tier metered formulas + annual rates + discount link. Updated SavingsEstimator to show Scale payback line when monthly savings ≥ $1500 (the threshold where Scale stops being theoretical).
- **Mathematical reality check**: the Scale tier is structurally required for heavy mid-market customers; without it, the pricing ladder jumps too abruptly from Team to Enterprise.

### Changed — license, billing posture, reliability posture

- **License: MIT → Apache-2.0** (`LICENSE` rewritten + new `NOTICE` file with maintainer note). Apache-2.0 was chosen over restrictive BSL-style licenses because early adoption matters more than legal friction.
- **Reliability posture (no formal SLA AND no status page today)** — `SECURITY.md` now has an explicit "Reliability posture" section: solo-team honest, no 99.9% promise, incidents communicated via direct email + GitHub Discussions until a public status page exists. Self-host is offered as the answer for procurement-blocking reliability requirements today.
- **Refund posture (no refunds, cancel any time)** — `SECURITY.md` adds a "Refunds and cancellation" section spelling out the rationale (refund flows invite gaming + dispute fees + accounting pain; monthly-billing-with-instant-cancel offers the same protection without the friction). Surfaced on `/billing` info card and `/estimate` page footer.
- **Q3 2026 outcome-aligned pricing pre-announce** — `/billing` page has a new green-bordered card announcing the move to `max($X floor, min(10% × monthly savings, $29 / $99 cap))` in Q3 2026. README's business-model section also pre-announces.

### Fixed

- **Auto-applied schema migrations at gateway boot** (`apps/gateway/src/migrate.ts`): Postgres' `docker-entrypoint-initdb.d` only runs SQL files on FIRST volume init, so any migration added after a developer's initial `docker compose up -d` lived in the filesystem but never reached their DB. Hit this bug twice in two sprints. New `runPendingMigrations()` runs at gateway boot before anything else touches the DB: tracks applied files in a `schema_migrations` table (sha256 + applied_at + duration_ms), applies pending ones in transactions, drift-detects edited files (loud warning, no re-apply since migrations are append-only), crashes the boot with a clear error if any migration fails (better than serving traffic against a half-migrated DB). `TOKENSMART_AUTO_MIGRATE=0` to disable for CI/multi-replica deploys. Migrations dir auto-discovered for both dev (`../../migrations`) and Docker (`./migrations`, mounted via volume in `docker-compose.prod.yml`).
- **Dashboard error classification** (`apps/dashboard/src/app/page.tsx`): "Database not reachable" message was misleading when the real failure was a missing column/table. Now distinguishes 3 cases: `column ... does not exist` → shows the exact `for f in migrations/*.sql; do ...` command, `relation ... does not exist` → suggests the `down -v && up -d` re-init, generic → unchanged.
- **Resilient optional queries** (`apps/dashboard/src/app/page.tsx`): `getQualityProofSummary` and `getSpendByTag` (which depend on migrations 006/007) moved out of the main `Promise.all` and given individual catch handlers, so a missing column gracefully degrades to "card hidden" instead of taking down the whole dashboard.

### Tests

- 79 unit tests pass (was 66 — +13 from key-rotator)
- Gateway typecheck clean
- Dashboard typecheck + build clean

---

## [v0.1.0] — 2026-04-22 night

### Added — narrative + integration + trust

- Rewritten **README.md** with hero value prop, comparison table vs LiteLLM / Helicone / Portkey / OpenRouter, and 60-second quickstart
- New **`docs/integrations/`** with tested guides for: OpenAI SDK (Python + Node), Vercel AI SDK, LangChain (Py + JS + LangGraph), Cursor, Cline, Continue.dev, Dify
- New **`SECURITY.md`** documenting threat model, encryption posture, vulnerability disclosure, sub-processors, retention policy, compliance roadmap
- New **`CONTRIBUTING.md`** with dev workflow, contribution flow, what's welcome / out of scope
- New **`docs/trust/dpa-template.md`** — Data Processing Addendum template for B2B procurement
- New **`docs/trust/sub-processors.md`** — sub-processors used by hosted

### Added — code

- **Cross-provider failover + automatic retry** on transient upstream errors (5xx / 429 from upstream / network timeouts). Configurable via `TOKENSMART_FAILOVER_MAP` env var (`gpt-4o=>claude-3-5-sonnet,gemini-pro=>gpt-4o`).
- **Per-request tagging** via `x-ts-tag` header. Comma-separated `key=value` pairs stored in `requests.tags` JSONB. New dashboard card "Spend by tag" groups spend by tag.
- **Quality proof card** on dashboard home — for shadow-routed experiments shows quality signal: cost delta + latency delta + error delta, framed as "the cheap model worked / didn't work".
- **Onboarding savings estimator** at `/estimate` — paste your monthly OpenAI spend + model breakdown, get an estimated TokSuan savings projection. No signup required.
- **Migration 006**: `requests.tags` JSONB column + GIN index for tag queries.

---

## [v0.0.9] — 2026-04-22 late evening

### Added

- End-to-end policy validation with full policy code eval (164) + policy chat eval (80) sweep across 6 frontier models
- 5-bucket Pareto policy at `apps/gateway/src/policy/baseline-policy.json` (chat/medium, code/medium, code/hard, reasoning/medium, reasoning/hard)
- "Saved $X" hero on dashboard home — measurable 30-day savings number
- `routing_saving_micro_cents` ledger column + backfill script
- BudgetForm with presets, live preview, burn-rate forecast (Tier 1–3c overhaul)
- `RoutingRuleForm` with model picker + threshold slider + 7-day match preview
- "Lock as project rule" one-click on request detail page
- Provider key Test button + 30d usage column on `/settings`
- Recommendations engine on dashboard home (4 rec types: wasteful_pattern, loop_spike, undersized_budget, no_budget_yet)
- Alert rule Test button + integration hints (Slack / Discord / 飞书 webhook patterns)

### Fixed

- 4 benchmark harness bugs in policy code eval runner (`extractPython` `.trim()` destroying indent, prelude drop, body-only column-0 SyntaxError, silent `max_tokens` truncation)
- Bucket-fallback for `simple` complexity in baseline policy (training data only emits medium/hard; runtime emits simple)
- Task-type-aware EPS multiplier (chat 2.0× vs code/reasoning 1.0×)

---

## [v0.0.7] — 2026-04-22 midday

### Added

- `LruTtlCache` + `CachingKeyProvider` decorator for KMS DEKs (10min TTL, 1000 entries)
- `GcpKmsKeyProvider` — full GCP KMS envelope encryption alongside AWS KMS
- Multi-backend registry — env / AWS / GCP can coexist, routed by fingerprint prefix
- Lazy AWS SDK client construction
- `--splitting` build → 299 KB entry, KMS SDKs in separate chunks
- LocalStack integration tests

---

## [v0.0.6] — 2026-04-22 late morning

### Added

- AWS KMS envelope encryption (`KmsKeyProvider`)
- Dual-backend registry (env + KMS coexistence)
- `migrate-to-kms` script for zero-downtime env → KMS migration

---

## [v0.0.5] — 2026-04-22 early morning

### Added

- `master_key_fingerprint` column on `user_provider_keys` (migration 004)
- `ops_audit_events` table for system-level events
- `ProviderKeyProvider` interface abstraction

---

## [v0.0.4] — 2026-04-21 late night

### Added

- BYO provider keys (`user_provider_keys` table, migration 003)
- AES-256-GCM encryption with shared crypto module across gateway + dashboard
- Per-request provider resolution (BYO-first, env-fallback)
- `/settings` page for managing BYO keys
- Master-key rotation script

---

## [v0.0.3] — 2026-04-21 night

### Added

- Cost-anomaly alert dispatch (`startCostAnomalyMonitor`)
- Native Anthropic provider (`/v1/messages`, not OpenAI-compat shim)
- Self-service Budgets / Routing / Alerts UI

---

## [v0.0.2] — 2026-04-21 late evening

### Added

- API key SHA-256 hashing
- SSE streaming with usage harvesting
- Anthropic auto `cache_control` injection
- Audit log (`audit_events` table)
- A/B shadow routing (`ab_results` table)
- Cost anomaly detection (z-score)
- Loop visualization on request detail page
- Optional smart classifier (LLM-judge)
- Cache-savings ledger

---

## [v0.0.1] — 2026-04-20

Initial release. Multi-provider routing, sub-cent spend tracking, budget enforcement, loop
detection, semantic router, prompt-cache pricing, alerts, multi-tenant auth, self-service
projects + API keys, Stripe billing, Resend email delivery, Docker production compose,
polished dashboard UI.
