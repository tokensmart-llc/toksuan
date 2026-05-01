# @toksuan/dashboard

Next.js 15 app for TokSuan. Reads the same Postgres the gateway writes to, and runs the hosted SaaS surface (auth, Stripe billing, BYO provider-key Settings, project / budget / routing / alert UIs, audit log).

For the product story see the top-level [`README.md`](../../README.md). For production deployment decisions, see [`docs/production-runbook.md`](../../docs/production-runbook.md).

## Stack

- Next.js 15 (App Router) + React 18, Bun as package manager and runtime
- Postgres via `postgres` (server components + server actions only)
- Stripe (`stripe` SDK) — checkout, customer portal, webhook-driven plan sync
- Resend — email delivery for OTP + magic link (auth only; alert emails still console-logged)
- Plain CSS with design tokens in `globals.css` — light + dark, no-flash boot script, no emoji. Landing pages use restrained gradients; app surfaces stay mostly flat.

## Run locally

```bash
# from repo root:
docker compose up -d                          # Postgres
cd apps/gateway && bun install && bun run dev  # gateway on :8787, writes rows the dashboard reads

# in this directory:
cp .env.example .env.local
bun install
bun run dev
```

Dashboard runs on `http://localhost:3000`. The public marketing homepage is `/`; the signed-in product dashboard is `/dashboard`.

## Modes

- **Single-tenant** (default): `TOKENSMART_AUTH_ENABLED` unset. No login, all projects visible. Good for self-host dev.
- **Multi-tenant hosted**: set `TOKENSMART_AUTH_ENABLED=1`. Email OTP + magic link (via Resend), cookie sessions, first-ever user claims any unowned seed projects, middleware gates every non-auth route.

## Pages

| Path | Purpose |
|---|---|
| `/` | Public marketing homepage |
| `/dashboard` | Product dashboard — savings hero, latest receipt, value report, diagnostics |
| `/login`, `/login/verify/route.ts`, `/logout` | OTP + magic-link flow, cookie clearing |
| `/projects` | List + create |
| `/projects/[id]` | API keys, budgets, routing rules, alert rules (all inline create / delete) |
| `/requests/[id]` | Request detail + loop-timeline SVG |
| `/settings` | BYO provider keys — paste OpenAI/Anthropic/etc., masked input, base_url override, fingerprint column showing which master key encrypted each row |
| `/audit` | Immutable user-scoped audit log |
| `/billing` | Stripe checkout + customer portal |
| `/api/stripe/webhook` | Plan sync from Stripe events |

## Env (quick ref)

```
DATABASE_URL=postgres://tokensmart:tokensmart_dev@localhost:5432/tokensmart
GATEWAY_URL=http://localhost:8787

TOKENSMART_AUTH_ENABLED=1

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_TEAM=price_...
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Resend (verified domain required for real delivery)
RESEND_API_KEY=re_...
RESEND_FROM=TokSuan <no-reply@mail.tokensmt.com>

# BYO provider keys — MUST be byte-identical to the gateway's value
TOKENSMART_PROVIDER_KEY_ENCRYPTION=<openssl rand -hex 32>
# or, for KMS-backed hosted: TOKENSMART_KMS_KEY_ARN or TOKENSMART_GCP_KMS_KEY_NAME
```

Full reference in `.env.example`.

## Gotchas

- **Logout uses `<a>`, not `<Link>`.** Cookie clearing requires a full navigation + setting headers on the outgoing `NextResponse` — `cookies().delete()` only mutates the incoming jar.
- **`TOKENSMART_PROVIDER_KEY_ENCRYPTION` must match the gateway.** They share no other channel. Mismatch → gateway throws "master key mismatch" with both fingerprints per request. Use `apps/gateway/scripts/rotate-master-key.ts` to change it safely.
- **Stripe: `STRIPE_PRICE_PRO` must be a `price_…` id, not a `prod_…` id.** Common mistake.
