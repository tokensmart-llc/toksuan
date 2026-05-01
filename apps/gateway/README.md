# @tokensmart/gateway

The TokSuan proxy + ledger. Every LLM request flows through here, gets fingerprinted, loop-checked, optionally re-routed, budget-checked, forwarded upstream, priced, and logged.

For the product story see the top-level [`README.md`](../../README.md). For production deployment decisions, see [`docs/production-runbook.md`](../../docs/production-runbook.md).

## Stack

- Bun (runtime)
- Hono (HTTP framework)
- Postgres (`postgres` driver)
- Zod (env / input validation)
- `@aws-sdk/client-kms` + `@google-cloud/kms` (optional, envelope-encryption backends for BYO provider keys; lazy-loaded, only the configured one is pulled in)

## Run locally

```bash
# from repo root: start Postgres
docker compose up -d

# in this directory:
cp .env.example .env   # edit at least one provider *_API_KEY
bun install
bun run dev
```

Gateway runs on `http://localhost:8787`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + DB check |
| POST | `/v1/chat/completions` | OpenAI-compatible proxy, full pipeline (auth → fingerprint → loop → routing → provider resolve → plan cap → budget → upstream), streaming + non-streaming |

## Auth

`Authorization: Bearer <key>`. Keys are SHA-256 hashed in `api_keys.key_hash` with a displayed `key_prefix` / `key_last4`. Plaintext `api_keys.key` still works for legacy rows and is opportunistically backfilled on first use.

The seed migration creates `tokensmart-dev-key` for local dev.

## Pipeline (what chat.ts actually does)

1. **Auth** — lookup by `key_hash`, or plaintext legacy path
2. **Parse + Zod-validate** the OpenAI ChatCompletion body
3. **Fingerprint** — `sha256(project + model + last-user-msg head + tools).slice(0,16)` computed on the *original* body
4. **Loop detector** — in-memory 5-min window, 10 hits → `429 loop_detected`
5. **Routing** — complexity classification (BYO same-provider LLM judge when available, local heuristic fallback) rewrites `body.model`; `shadow` / `both` modes also fire a parallel A/B call
6. **Provider resolve** — match model pattern → try user's BYO key (envelope-decrypted via env / AWS KMS / GCP KMS) → fall back to env-registered provider
7. **Plan cap** — 24h rolling user ceiling from `users.plan`
8. **Budget** — per-project daily/monthly `limit_micro_cents`
9. **Upstream** — OpenAI-compat or native Anthropic `/v1/messages`. Streaming auto-injects `stream_options: { include_usage: true }`
10. **Price + log** — writes to `requests` with `cost_micro_cents`, `cache_savings_micro_cents`, `streamed` flag, fingerprint, original vs routed model

## Scripts

```bash
bun run set-budget    -- --period daily --micro-cents 100
bun run set-routing   -- --from "^gpt-4o$" --to "gpt-4o-mini" --threshold 0.3
bun run set-routing   -- --from "^gpt-4o$" --to "gpt-4o" --mode shadow --shadow "gpt-4o-mini"
bun run set-alert     -- --event budget_exceeded --webhook https://...
bun run rotate-master-key         # OLD=… NEW=… to re-encrypt BYO keys
bun run migrate-to-kms            # env-master-key → AWS KMS, one-time
bun test                           # gateway suite; + LocalStack integration tests when reachable
bun run build                      # bun build --splitting → dist/ (entry ~299 KB)
```

## Env (quick ref)

```
PORT=8787
DATABASE_URL=postgres://tokensmart:tokensmart_dev@localhost:5432/tokensmart
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=sk-ant-...            # native /v1/messages, enables auto cache_control
# plus GOOGLE_API_KEY, DEEPSEEK_API_KEY, QWEN_API_KEY, DOUBAO_API_KEY as needed

# BYO provider keys (hosted multi-tenant). Pick exactly one crypto backend:
TOKENSMART_PROVIDER_KEY_ENCRYPTION=<openssl rand -hex 32>   # env-backed master key
TOKENSMART_KMS_KEY_ARN=arn:aws:kms:...:key/...              # AWS KMS envelope
TOKENSMART_GCP_KMS_KEY_NAME=projects/.../cryptoKeys/...     # GCP KMS envelope

# Optional feature flags
TOKENSMART_AUTO_CACHE_CONTROL=1
TOKENSMART_CLASSIFIER_MODE=byo_same_provider  # default: user pays via their BYO same-provider key
TOKENSMART_CLASSIFIER_MODEL=gpt-4o-mini       # only used with TOKENSMART_CLASSIFIER_MODE=explicit
TOKENSMART_KMS_CACHE_TTL_MS=600000
TOKENSMART_KMS_CACHE_MAX_SIZE=1000
```

Full reference in `.env.example`.

## Routing Philosophy

TokSuan is a spend-control router, not a cheap-model proxy:

- `simple` turns route aggressively to fast inexpensive models.
- `medium` turns use the cost-quality frontier.
- `hard` and `frontier` turns keep advanced models unless benchmark and
  project-specific evidence is strong enough to switch.
- Complexity judging defaults to the customer's BYO key in the same provider
  family as the requested model. A customer who only provides an OpenAI key gets
  an OpenAI judge; a customer who only provides Anthropic gets a Haiku judge.
  TokSuan does not spend platform provider keys or send prompts across
  providers unless explicitly configured.

As a project accumulates real `requests` and `ab_results`, retraining can
promote a per-project policy that reflects that agent's workload. The product
story is "day-one savings from the public frontier, then better routing as your
agent runs."
