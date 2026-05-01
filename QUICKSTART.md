# TokSuan — Quickstart

Developer + operator setup. For the product story, read [`README.md`](README.md) first. For production deployment decisions, read [`docs/production-runbook.md`](docs/production-runbook.md).

**Want to know what TokSuan will save you before signing up?** Try the
public [savings estimator](https://tokensmt.com/estimate) — two inputs, no account.

Three ways to run TokSuan:

1. **[Hosted](#hosted-tokensmtcom)** — sign in at tokensmt.com, paste your provider key, done (2 minutes)
2. **[Self-host dev](#self-host--dev)** — local Postgres + gateway + dashboard with hot reload (5 minutes)
3. **[Self-host prod](#self-host--production)** — three-container Docker Compose, what we run in prod (10 minutes)

For drop-in integration guides for OpenAI SDK / Vercel AI SDK / LangChain /
Cursor / Cline / Continue / Dify, see [`docs/integrations/`](docs/integrations/).
For production deployment decisions, use [`docs/production-runbook.md`](docs/production-runbook.md).

---

## Hosted (tokensmt.com)

The fastest path for most people.

1. Visit [tokensmt.com](https://tokensmt.com), enter your email. A 6-digit OTP lands in your inbox (or click the magic link).
2. Open **Settings → Provider keys**. Paste one key for each provider family
   you want TokSuan to consider (OpenAI / Anthropic / Google / DeepSeek /
   Qwen / Doubao). Hosted production encrypts each key with AWS KMS envelope
   encryption and stores only `…last4` in cleartext. (GCP KMS is supported in
   code for self-host / future hosted deployments.)
3. Open **Projects**, click **New project**, click **Create API key**. You get a `ts_…` style key shown **once** — copy it.
4. Point your SDK at the hosted gateway:

   ```bash
   curl https://gateway.tokensmt.com/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer ts_your_project_key_here" \
     -d '{
       "model": "gpt-4o-mini",
       "messages": [{"role": "user", "content": "Say hello in 5 words"}]
     }'
   ```

   Or in Python:

   ```python
   from openai import OpenAI

   client = OpenAI(
       base_url="https://gateway.tokensmt.com/v1",
       api_key="ts_your_project_key_here",
   )
   resp = client.chat.completions.create(
       model="gpt-4o-mini",
       messages=[{"role": "user", "content": "Say hello in 5 words"}],
   )
   ```

5. Back in the dashboard, you'll see the request land with its cost in
   `micro_cents`. Set a **Budget** (daily/monthly), a **Routing rule** (e.g.
   send anything matching `^gpt-4o$` to `gpt-4o-mini` when complexity < 0.3),
   or an **Alert** (webhook on `budget_exceeded` / `loop_detected` /
   `cost_anomaly`). The built-in classifier defaults to a cheap judge from the
   same provider family as the requested model and uses the user's BYO key when
   available; if no matching key exists, it falls back to a local heuristic.

Free → $0 / Pro → $29 / Team → $99 monthly via Stripe. **You keep paying model
providers directly.** We don't take a spread on tokens.

---

## Self-host — dev

For hacking on TokSuan itself, or running it against a local Postgres.

### Prerequisites

- **Bun** ≥ 1.1 — `curl -fsSL https://bun.sh/install | bash`
- **Docker** + Docker Compose
- **Git**

No Node, no pnpm, no Python.

### One-shot install (recommended, ~2 minutes)

If you just cloned this repo, run:

```bash
./install.sh
```

The script does the prereq check, boots Postgres + pgweb, generates a master encryption key once and writes it to BOTH `apps/gateway/.env` and `apps/dashboard/.env.local` (the #1 footgun otherwise), runs `bun install` in both apps, and prints the exact commands to start each process. Idempotent — safe to re-run. Pass `--noninteractive` for CI / Dockerfile use, `--skip-deps` to skip `bun install`.

### First-time setup, manual (5 minutes)

```bash
# 1. Postgres + pgweb (browser-based DB explorer)
docker compose up -d
# Postgres: localhost:5432  (user: tokensmart, pass: tokensmart_dev, db: tokensmart)
# pgweb:    http://localhost:8081

# 2. Gateway env
cp apps/gateway/.env.example apps/gateway/.env
# Edit apps/gateway/.env:
#   - set at least one upstream provider (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...)
#   - optionally set TOKENSMART_PROVIDER_KEY_ENCRYPTION if you want BYO in dev
#   - default classifier mode is byo_same_provider; set TOKENSMART_CLASSIFIER_MODE=explicit
#     only if you want one operator-paid judge model for the whole gateway

# 3. Gateway (Bun + Hono on :8787)
cd apps/gateway
bun install
bun run dev

# 4. Dashboard env
cd ../dashboard
cp .env.example .env.local
# Edit .env.local — most defaults work; set TOKENSMART_AUTH_ENABLED=1 to test auth,
# or leave it unset for single-tenant mode (no login required).

# 5. Dashboard (Next.js on :3000)
bun install
bun run dev
```

Three URLs:
- Gateway:   http://localhost:8787
- Public landing: http://localhost:3000
- Dashboard: http://localhost:3000/dashboard
- pgweb:     http://localhost:8081

### Smoke-test the gateway

```bash
curl http://localhost:8787/health
# => {"ok":true,"version":"0.0.1","db":"up"}

# Make a chat completion through the gateway.
# In single-tenant dev mode, the seed API key is "tokensmart-dev-key":
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tokensmart-dev-key" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello in 5 words"}]
  }'
```

Open http://localhost:3000/dashboard and you should see the request, its token counts, its cost in `micro_cents`, and its latency. The root path is the public marketing homepage. In auth-enabled mode, sign in first; your first-ever sign-in claims any unowned seed projects so you don't lose dev data.

### BYO provider keys in dev (optional)

```bash
# Generate a 32-byte master key — paste into BOTH gateway .env and dashboard .env.local
openssl rand -hex 32

# In apps/gateway/.env:
TOKENSMART_PROVIDER_KEY_ENCRYPTION=<paste_the_hex>

# In apps/dashboard/.env.local (MUST be the same value):
TOKENSMART_PROVIDER_KEY_ENCRYPTION=<paste_the_same_hex>
TOKENSMART_AUTH_ENABLED=1
```

Restart both processes. Sign in at `/login`, then visit `/settings` → paste your own OpenAI key. The gateway will now decrypt it per-request and use **your** key instead of the env-configured one.

---

## Self-host — production

Three containers (Postgres + gateway + dashboard) via a single compose file. No Bun / Node on the host beyond Docker.

```bash
cp .env.prod.example .env.prod
# Edit .env.prod — walk through the file top-to-bottom, it's commented.
# Minimum viable prod:
#   - POSTGRES_PASSWORD (required)
#   - at least one upstream provider key (OPENAI_API_KEY / ANTHROPIC_API_KEY / ...)
#     OR leave operator-side env provider keys empty if every user will
#     paste their own BYO key at /settings
# Highly recommended:
#   - NEXT_PUBLIC_BASE_URL + GATEWAY_PUBLIC_URL (real hostnames, not localhost)
#   - RESEND_API_KEY + RESEND_FROM (users on a public box can't read your docker logs)
#   - TOKENSMART_PROVIDER_KEY_ENCRYPTION (or TOKENSMART_KMS_KEY_ARN / TOKENSMART_GCP_KMS_KEY_NAME)
#   - TOKENSMART_INTERNAL_REPLAY_ENABLED=1 + TOKENSMART_INTERNAL_TOKEN
#     (unlocks the /requests/[id] Replay button)
# Optional:
#   - Stripe keys for /billing (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_{PRO,TEAM,SCALE})
#   - OTEL_EXPORTER_OTLP_ENDPOINT for trace export to Langfuse/Datadog/etc.
#   - NEXT_PUBLIC_DOCS_URL if you mirror the docs under your own domain

docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Gateway → `:8787`, dashboard → `:3000`. Both have health checks and restart-on-failure. **`pgweb` is intentionally omitted** from the prod compose so nobody accidentally exposes an unauthenticated DB UI to the public internet.

### Auth mode — multi-tenant (default) vs single-tenant

The prod compose defaults to `TOKENSMART_AUTH_ENABLED=1` — users sign up at
`/login` (email OTP), mint their own API keys at `/projects`, and paste
BYO provider keys at `/settings`. This is the well-trodden path.

If you explicitly want single-tenant mode (you are the only operator, no
dashboard auth): set `TOKENSMART_AUTH_ENABLED=0` in `.env.prod`. On first
boot the gateway detects an empty `api_keys` table and mints a one-time
bootstrap key, printed loudly in its own logs:

```
docker logs toksuan-gateway
# ...
# [bootstrap] Minted a one-time bootstrap key. Copy it NOW — it is
# [bootstrap] only shown in these logs (we store a SHA-256 hash).
# [bootstrap]   ts_<48 random hex chars>
```

Copy it into your agent config and go. To rotate: `docker exec
toksuan-postgres psql -U toksuan -d toksuan -c 'TRUNCATE
api_keys;'` then restart the gateway.

### Scheduled jobs (operator's responsibility)

The compose file does NOT run any cron — schedule these externally. None
of the product's correctness depends on them running (grace keys are
filtered at read time, soft-deleted users are excluded by the auth
layer), but skipping them long-term lets rotation residue + tombstones
accumulate in the admin UI.

| Script | Suggested schedule | What it does |
|---|---|---|
| `bun run sweep-old-requests` | daily 02:30 UTC | Enforces the 90-day rolling window on `requests` / `ab_results`. Gated on `TOKENSMART_REQUEST_RETENTION_DAYS` (unset = no-op, which is the right default for self-host) |
| `bun run sweep-expired-auth` | daily 03:00 UTC | Hard-deletes `sessions` past their 30-day grace + `magic_links` past their 7-day grace |
| `bun run sweep-expired-api-keys` | daily | Hard-deletes API keys past their 24h rotation-grace window |
| `bun run sweep-deleted-users` | daily | Hard-deletes users past their 30d soft-delete grace |
| `bun run send-weekly-savings` | Mon 10:00 UTC | Weekly savings digest email to opted-in users |
| `bun run settle-referrals` | daily 04:30 UTC | Mints Stripe customer-balance credits for referral commissions |

Three ways to wire them:

1. **GitHub Actions** (what we run for hosted). See
   `.github/workflows/{weekly-digest,settle-referrals}.yml`; copy the
   shape for the two sweeps if you publish your repo.
2. **Host crontab** on the docker host:
   ```cron
   30 4 * * *  docker exec toksuan-dashboard bun run settle-referrals >> /var/log/toksuan.log 2>&1
   0  10 * * 1 docker exec toksuan-dashboard bun run send-weekly-savings >> /var/log/toksuan.log 2>&1
   0  3  * * * docker exec toksuan-dashboard bun run sweep-expired-api-keys >> /var/log/toksuan.log 2>&1
   30 3  * * * docker exec toksuan-dashboard bun run sweep-deleted-users >> /var/log/toksuan.log 2>&1
   ```
3. **Sidecar `cron` container** in a compose override file — add an
   `ofelia`, `mcuadros/ofelia`, or plain `busybox crond` service that
   `docker exec`'s into `toksuan-dashboard`.

### KMS-backed BYO (hosted-grade crypto)

For production multi-tenant installs you probably don't want to keep a 32-byte master key in an env var on your server. Switch to envelope encryption:

```bash
# AWS KMS (minimum IAM: kms:GenerateDataKey + kms:Decrypt on the CMK)
TOKENSMART_KMS_KEY_ARN=arn:aws:kms:us-east-1:…:key/…

# or GCP KMS (uses Application Default Credentials)
TOKENSMART_GCP_KMS_KEY_NAME=projects/…/locations/…/keyRings/…/cryptoKeys/…
```

Both can coexist with an env-based master key during migration windows — the gateway routes decrypts by the fingerprint prefix stamped on each row (`kms:` → AWS, `gcp:` → GCP, pure hex → env). Migration script below.

---

## Operational cheat sheet

### CLI tools (in `apps/gateway/`)

```bash
# Create / update a per-project budget
bun run set-budget   -- --period daily --micro-cents 100

# Create a routing rule
bun run set-routing  -- --from "^gpt-4o$" --to "gpt-4o-mini" --threshold 0.3

# A/B shadow route: run gpt-4o-mini in parallel against gpt-4o for comparison
bun run set-routing  -- --from "^gpt-4o$" --to "gpt-4o" --mode shadow --shadow "gpt-4o-mini"
bun run set-routing  -- --list

# Create an alert
bun run set-alert    -- --event budget_exceeded --webhook https://webhook.site/xxx
bun run set-alert    -- --event loop_detected   --webhook https://webhook.site/xxx
bun run set-alert    -- --event cost_anomaly    --webhook https://webhook.site/xxx
```

Everything these CLIs do is also exposed in the dashboard UI at `/projects/[id]`, and every change is audited.

### Migrations (auto-applied)

As of v0.3, the gateway applies every `migrations/*.sql` file at boot via
`apps/gateway/src/migrate.ts` — you'll see `[migrate] applied 00X_*.sql (Nms)`
in gateway stdout on first run. No manual psql is needed.

If you deploy multiple gateway replicas and want exactly ONE process to drive
migrations (vs racing on the same SQL), set `TOKENSMART_AUTO_MIGRATE=0` on the
N-1 replicas; the flagged-off processes warn at boot if there are pending files
but won't apply them.

Current migrations (see `migrations/`):
`001_init`, `002_advanced`, `003_byo_keys`, `004_key_versioning_ops_audit`,
`005_routing_savings`, `006_request_tags`, `007_shadow_similarity`,
`008_weekly_digest_optin`, `009_referrals`, `010_prompt_templates`,
`011_organizations_rbac`, `012_sso_saml`.

### Master-key rotation (env-based BYO)

```bash
cd apps/gateway
TOKENSMART_PROVIDER_KEY_ENCRYPTION_OLD=<old> \
TOKENSMART_PROVIDER_KEY_ENCRYPTION_NEW=<new> \
  bun run rotate-master-key -- --dry-run     # preview — no writes
TOKENSMART_PROVIDER_KEY_ENCRYPTION_OLD=<old> \
TOKENSMART_PROVIDER_KEY_ENCRYPTION_NEW=<new> \
  bun run rotate-master-key                  # commit — one atomic transaction
# Then swap TOKENSMART_PROVIDER_KEY_ENCRYPTION = <new> on BOTH processes and restart.
# Customers' BYO plaintext keys are unchanged — they don't need to re-paste.
```

### Env → KMS migration (one-time, zero-downtime)

Set both env + KMS vars on both processes and restart, so new writes go to KMS and old reads still work via env:

```bash
cd apps/gateway
bun run migrate-to-kms -- --dry-run         # preview
bun run migrate-to-kms                      # commit, batched per-txn
```

Idempotent — re-runs pick up only rows still on env/NULL fingerprints.

### Stripe local testing

```bash
# Keep this running while testing checkout flows:
stripe listen --forward-to http://localhost:3000/api/stripe/webhook
# Copy the whsec_… into apps/dashboard/.env.local as STRIPE_WEBHOOK_SECRET, restart dashboard.
# Test card: 4242 4242 4242 4242, any future expiry, any CVC.
```

### Tests

```bash
cd apps/gateway && bun test
# 361 tests in the current snapshot (crypto invariants, envelope pack/unpack,
# dual-backend routing, semantic cache, routing headers, rewrite fallback,
# request-body storage, fingerprint stability, mismatch rejection).

# Optional: +4 LocalStack integration tests against the real AWS SDK path
docker compose -f docker-compose.test.yml up -d localstack
./scripts/test-setup-localstack.sh          # creates a CMK, writes .localstack-kms.env
source .localstack-kms.env
cd apps/gateway && bun test                 # integration tests included
docker compose -f docker-compose.test.yml down
```

### Useful psql one-liners

```bash
# Recent requests
docker exec -it toksuan-postgres psql -U toksuan -d toksuan -c \
  "SELECT id, model, input_tokens, output_tokens, cost_micro_cents/1000.0/100.0 AS cost_usd, status, created_at FROM requests ORDER BY created_at DESC LIMIT 10;"

# Today's spend by model
docker exec -it toksuan-postgres psql -U toksuan -d toksuan -c \
  "SELECT model, COUNT(*) AS calls, SUM(cost_micro_cents)/1000.0/100.0 AS cost_usd FROM requests WHERE created_at >= DATE_TRUNC('day', NOW()) GROUP BY model ORDER BY cost_usd DESC;"

# Reset today's spend without nuking the DB
docker exec -it toksuan-postgres psql -U toksuan -d toksuan -c \
  "DELETE FROM requests WHERE created_at >= DATE_TRUNC('day', NOW());"

# Operator audit log (rotation events, migration lifecycle, system)
docker exec -it toksuan-postgres psql -U toksuan -d toksuan -c \
  "SELECT created_at, actor, event, metadata FROM ops_audit_events ORDER BY created_at DESC LIMIT 20;"

# Nuke + reseed the whole dev DB
docker compose down -v && docker compose up -d
```

---

## Repo layout (high-level)

```
.
├── README.md                   # product story + positioning
├── QUICKSTART.md               # ← you are here
├── LICENSE                     # Apache-2.0
├── NOTICE                      # Apache-2.0 attribution + maintainer note
├── docker-compose.yml          # dev: Postgres + pgweb
├── docker-compose.prod.yml     # prod: Postgres + gateway + dashboard
├── docker-compose.test.yml     # test: LocalStack for KMS integration tests
├── .env.prod.example           # all prod envs documented
├── docs/
│   ├── production-runbook.md   # production deployment checklist
│   ├── trust/                  # public trust docs (open-source boundary, agent action boundary, DPA template, sub-processors)
│   └── integrations/           # SDK + tool integration guides
├── migrations/
│   ├── 001_init.sql
│   ├── 002_advanced.sql            # streaming, hashing, A/B, audit, anomaly
│   ├── 003_byo_keys.sql            # BYO provider keys (encrypted)
│   └── 004_key_versioning_ops_audit.sql
├── scripts/
│   └── test-setup-localstack.sh
└── apps/
    ├── gateway/                # Bun + Hono + TypeScript
    │   ├── Dockerfile
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── config.ts           # env + provider registry + feature flags
    │   │   ├── db.ts
    │   │   ├── pricing.ts          # per-model rates (input / output / cached)
    │   │   ├── plans.ts            # Free / Pro / Team / Scale caps (mirror of dashboard)
    │   │   ├── budget.ts           # checkBudget()
    │   │   ├── fingerprint.ts      # project + model + msg-head + tools hash
    │   │   ├── loop-detector.ts    # in-memory rolling window
    │   │   ├── router.ts           # applyRouting() — route | shadow | both
    │   │   ├── classifier.ts       # heuristic + optional LLM-judge complexity
    │   │   ├── cache-control.ts    # Anthropic auto cache_control injection
    │   │   ├── shadow.ts           # dispatchShadow() — fire-and-forget A/B
    │   │   ├── alerts.ts           # dispatchAlert()
    │   │   ├── anomaly.ts          # detectProjectAnomaly()
    │   │   ├── monitor.ts          # startCostAnomalyMonitor()
    │   │   ├── crypto.ts           # ProviderKeyProvider interface + envelope
    │   │   ├── lru-ttl-cache.ts    # LRU + TTL used by CachingKeyProvider
    │   │   ├── kms-provider.ts     # AWS KMS envelope
    │   │   ├── gcp-kms-provider.ts # GCP KMS envelope
    │   │   ├── provider-resolve.ts # resolveProvider() — BYO-first, env-fallback
    │   │   ├── routes/
    │   │   │   ├── health.ts
    │   │   │   └── chat.ts         # full pipeline, streaming + non-streaming
    │   │   └── providers/
    │   │       ├── openai.ts       # OpenAI-compat upstream
    │   │       └── anthropic.ts    # native /v1/messages transport
    │   ├── scripts/
    │   │   ├── set-budget.ts
    │   │   ├── set-routing.ts
    │   │   ├── set-alert.ts
    │   │   ├── rotate-master-key.ts
    │   │   └── migrate-to-kms.ts
│   └── test/                   # 361 tests + optional LocalStack tests
    └── dashboard/              # Next.js 15 (App Router) + Bun
        ├── Dockerfile
        ├── next.config.ts          # output: 'standalone'
        └── src/
            ├── middleware.ts       # cookie auth gate
            ├── lib/                # db, auth, email, stripe, plans, audit, anomaly, crypto
            ├── components/         # Logo, ThemeToggle, ToastHost, CopyButton, Sparkline, DailyBars, ShareBar, LoopTimeline
            └── app/                # dashboard, projects, settings, audit, billing, login, requests
```

---

## Troubleshooting

- **`ECONNREFUSED` on Postgres** → `docker compose ps` to check the container is up. If it's up but gateway still refuses, confirm `DATABASE_URL` matches the compose password.
- **Dashboard shows no data** → did you hit the gateway at least once? Only `/v1/chat/completions` writes rows. `/health` does not.
- **`master key mismatch` in gateway logs** → `TOKENSMART_PROVIDER_KEY_ENCRYPTION` is different between gateway and dashboard. They share no other channel; these two values MUST be byte-identical. If you intentionally rotated, see the master-key rotation recipe above.
- **Stripe `STRIPE_PRICE_PRO must be a price_… id`** → you pasted a `prod_…` product id. Price ids live inside the product detail page.
- **Magic-link emails not arriving** → Resend test mode only sends to the email you verified. Verify your domain in the Resend dashboard first, then set `RESEND_FROM=You <login@your-verified-domain>`.
- **`dig` to public DNS hangs** (if you're testing from mainland China) → port 53 is blocked upstream. Use `https://dns.google/resolve?name=…` or just trust Resend's own verify button. Not a code bug.
- **Loop detector "forgot" my counts after restart** → it's in-memory by design for v0. When you horizontally scale, we'll promote it to Redis.
