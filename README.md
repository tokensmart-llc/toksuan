# TokSuan

> **The spend-control plane for AI agents.**
> See it. Cap it. Shrink it. Keep it running.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh)
[![Made for agents](https://img.shields.io/badge/made%20for-AI%20agents-purple.svg)](#why-toksuan)

English | [中文](README.zh-CN.md)

![TokSuan tutorial screenshot](docs/assets/toksuan-tutorial.png)

Your AI agents are spending in the dark. TokSuan is operated by TokenSmart LLC
and sits between your agent and upstream model providers. It keeps the
OpenAI-compatible API shape your tools already use, then adds receipts, budgets,
loop protection, evidence-based routing, and context compression before the
request reaches the LLM.
It is not a cheap-model proxy: simple turns can route to fast inexpensive
models, hard/frontier turns keep high-quality models unless there is strong
evidence to switch, and each project's real traffic improves future routing.

```bash
curl https://gateway.tokensmt.com/v1/chat/completions \
  -H "Authorization: Bearer ts_your_project_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hello in 5 words"}]}'
```

Try the hosted flow at [tokensmt.com](https://tokensmt.com), or self-host from
this repo.

## Why TokSuan

Long-running AI agents create three operational problems:

| Problem | TokSuan answer |
|---|---|
| You cannot see what every agent turn cost | Request ledger with model, tokens, latency, tags, cost, and savings |
| A loop can burn money before anyone notices | Daily/monthly budgets, loop detection, and plan caps before upstream billing |
| Frontier models handle trivial work | Benchmark-derived routing, shadow trials, and proof headers before promotion |
| Tool output bloats every turn | Deterministic context compression for JSON rows, logs, diffs, stack traces, and shell output |
| Agents need multiple model families | BYO provider keys for OpenAI, Anthropic, Google, DeepSeek, Qwen, and Doubao, with routing that sends each task to the best-fit provider |

The result is a per-request receipt:

```text
X-Tokensmart-Asked-Model: gpt-5.5
X-Tokensmart-Landed-Model: deepseek-chat
X-Tokensmart-Routing-Reason: baseline:chat:simple
X-Tokensmart-Cost-Saved-Vs-Asked-Cents: 0.940000
X-Tokensmart-Tool-Compress-Chars-Saved: 4200       # only when the
X-Tokensmart-Tool-Compress-Saved-Cents: 0.060000   # compressor is opted in
```

For paid API providers, TokSuan can show dollar savings from token prices.
For self-hosted/custom endpoints, it shows routing and capacity movement unless
you configure your own pricing metadata.

TokSuan does not take a token spread and does not require a platform-owned
classifier key. By default, complexity judging uses the customer's BYO key from
the same provider family as the requested model (for example, OpenAI requests
use a cheap OpenAI judge, Anthropic requests use Haiku, DeepSeek requests use a
small DeepSeek model). If no matching BYO key exists, TokSuan falls back to a
local heuristic rather than sending prompts to another provider.

## Context compression (opt-in)

Agents do not just think. They replay.

A coding agent may send the same git diff, test log, stack trace, or JSON result
back to the model for many turns. TokSuan cuts that replay tax with an opt-in
deterministic context-compression pipeline: audit first, optimize when ready,
and keep originals recoverable when reversible storage is enabled.

Recognised shapes (heuristic-only, no command-name signal needed):

- **git status** — collapsed to branch + counts (`18 staged, 6 untracked`)
- **git diff** — strips `index`/`---`/`+++` noise, elides body over budget
- **shell listings** — `ls -l` / `find` / `tree` — head + tail with
  middle elided
- **stack traces** — keeps error message + first/last frames
- **NDJSON / structured logs** — buckets by `level`, collapses repeats
- **JSON arrays / object rows** — SmartCrusher keeps head, tail, and error-like
  rows while replacing dropped runs with compact sentinels
- **ANSI-coloured output** — strips escape sequences
- **Repeating log lines** — consecutive identical lines → `<line> (×N)`

Typical per-message savings: 60-95% on eligible coding-agent output. In a live
DeepSeek gateway test, a JSON tool result compressed from 10,574 chars to 1,198
chars while preserving a buried error row — **88% fewer input bytes**.
See `apps/gateway/scripts/preview-tool-compress.ts` for before/after demos.

Design constraints — the compressor is intentionally conservative because it
operates at the API layer:

- **Only `tool` / `function` role messages are touched.** System,
  user, and assistant content is never modified.
- **Heuristic shape detection only.** The original command name
  (`git status`, `cargo test`) is often lost by the time bytes reach the
  gateway, so we identify content shape from structure alone. Unknown shapes
  pass through unchanged.
- **Idempotent + deterministic.** Running the compressor twice yields
  identical bytes — loop-detection fingerprints stay stable, replays
  are reproducible.
- **Audit before optimize.** Use `TOKENSMART_CONTEXT_COMPRESS_MODE=audit` to
  measure potential savings without rewriting prompts, then switch to
  `optimize` when the receipt looks safe.
- **Reversible when enabled.** With `TOKENSMART_CONTEXT_COMPRESS_STORE=1`,
  TokSuan stores the original tool output in `compressed_blobs` and shows it
  on the request detail page.
- **Off by default.** Silently rewriting prompts conflicts with the trust
  contract. Operators opt in knowingly.

Configuration:

```bash
TOKENSMART_CONTEXT_COMPRESS_MODE=off       # off | audit | optimize
TOKENSMART_CONTEXT_COMPRESS_STORE=0        # set 1 to retain originals
TOKENSMART_CONTEXT_COMPRESS_CRUSH_JSON=1   # JSON SmartCrusher
```

Per-call override: `x-ts-context-compress: off|audit|optimize`.
Legacy `TOKENSMART_TOOL_COMPRESS_ENABLED=1` still maps to `optimize`.

Visibility when the compressor fires:

- Response headers `X-Tokensmart-Tool-Compress-Chars-Saved` and
  `X-Tokensmart-Tool-Compress-Saved-Cents` for same-trip proof
- Dedicated cell in the dashboard's "Saved · last 30 days" hero card
  alongside routing and prompt-cache savings
- Per-request tags (`context_compress_mode`, `context_compress_shape`,
  `context_compress_chars_saved`, plus legacy `tool_compress_*` realized
  savings tags) on the request row for audit + per-shape analytics
- Optional request-detail view of original vs compressed content when
  reversible storage is enabled

Design and env knobs in `apps/gateway/src/compression/`
(`tool-result-compressor.ts` remains a compatibility export).

No invisible magic: every optimization leaves a receipt. Routing says why the
model changed. Compression says how many bytes were removed. Reversible storage
keeps the original tool output available for audit.

## Built For Real Agents

OpenClaw and Hermes Agent are the reference workloads for this project: real
personal agents with long sessions, tool use, context replay, multiple channels,
and real risk of runaway spend.

Use TokSuan to put each agent in its own project, set a budget, and inspect
every turn in the dashboard while the agent keeps its normal workflow. Send
`x-ts-agent`, `x-ts-session`, `x-ts-turn`, and `x-ts-channel` when your agent
supports custom headers so TokSuan can group spend by session.

TokSuan is not an action firewall. A model gateway can enforce model spend
because every model request passes through it; it cannot guarantee protection
for shell commands, database writes, cloud APIs, or tool calls that execute
outside the model request path. TokSuan's safety boundary is behavior
visibility and cost guardrails: make agent activity and spend understandable,
stop runaway model loops, and route work to cheaper models when the policy has
evidence it is safe.

- OpenClaw quick guide: [`examples/openclaw/`](examples/openclaw/)
- Hermes Agent quick guide: [`examples/hermes-agent/`](examples/hermes-agent/)
- Advanced header contract: [`docs/integrations/openclaw.md`](docs/integrations/openclaw.md)
- Agent action boundary: [`docs/trust/agent-action-boundary.md`](docs/trust/agent-action-boundary.md)

## What Is Included

### Gateway

- OpenAI-compatible `/v1/chat/completions` proxy
- Native Anthropic `/v1/messages` adapter
- Provider support for OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, Doubao
- Per-project API keys, hashed at rest
- Request ledger with sub-cent precision (`micro_cents`) plus safe tool-intent
  metadata when model responses expose tool calls
- Daily/monthly budgets and loop detection
- Baseline routing policy with public-safe model IDs
- Project routing rules, shadow mode, and A/B quality proof
- Per-provider BYO complexity judging and per-project routing optimization
- Retry, failover, cache-control injection, tags, alerts, and semantic cache
- **Context compression (opt-in)** — shrinks `tool` / `function` messages
  (JSON arrays, git status, git diff, stack traces, NDJSON logs,
  ANSI-coloured output, spammy repeating lines) before forwarding upstream.
  Supports audit mode and optional reversible original storage. See
  [Context compression](#context-compression-opt-in) above for the
  design.

### Dashboard

- Email OTP auth
- Projects, API keys, budgets, routing rules, alerts, audit log
- Savings receipt and 7-day value report
- Three-dimensional savings hero card: **routing savings**, **prompt-cache
  savings**, **context compression savings** (only renders cells whose
  dimension actually fired in the window)
- Provider-key upload with encrypted storage
- Agents/session view when callers send attribution headers
- Trust page and production health posture

### Deployment

- Local dev via Docker Compose
- **Single-binary SQLite trial mode** for both gateway and dashboard — no
  Postgres, no Docker. Point `DATABASE_URL=sqlite:./data/toksuan.db` and
  the runtime auto-migrates. Multi-tenant features (auth, KMS, plan caps,
  semantic cache) gracefully degrade; single-tenant trial is fully usable.
- Production Compose file for self-hosting
- Hosted-friendly env for Vercel dashboard + Render gateway + Neon Postgres
- Scriptable retention and pricing-freshness jobs (`bun run sweep-old-requests`,
  `bun run pricing-freshness`); pick any scheduler (cron / GitHub Actions / Fly /
  Kubernetes CronJob)

## Quick Start

### Hosted

1. Visit [tokensmt.com](https://tokensmt.com) and choose **Start free**.
2. Add one upstream key in **Settings -> Provider keys**.
3. Follow the in-product next step: create a project and copy the `ts_...` API key.
4. Run the generated curl command or point your SDK/agent to `https://gateway.tokensmt.com/v1`.
5. Inspect the first receipt on the dashboard.

### Self-host dev (Postgres)

```bash
git clone https://github.com/tokensmart-llc/toksuan.git
cd toksuan

docker compose up -d
cp apps/gateway/.env.example apps/gateway/.env
# Edit apps/gateway/.env and set at least one provider key.

cd apps/gateway && bun install && bun run dev
cd ../dashboard && bun install && bun run dev
```

Then open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) and send a smoke
request through the gateway:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer tokensmart-dev-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

For production self-hosting, see [`QUICKSTART.md`](QUICKSTART.md) and
[`docs/production-runbook.md`](docs/production-runbook.md).

### Self-host trial (SQLite, no Docker)

Single-binary mode for users who want to evaluate TokSuan locally without
spinning up Postgres. Both gateway and dashboard read from the same SQLite
file; multi-tenant features (auth, KMS, plan caps, semantic cache,
recommendations) gracefully degrade.

```bash
git clone https://github.com/tokensmart-llc/toksuan.git
cd toksuan

# Gateway env
cat > apps/gateway/.env <<'EOF'
DATABASE_URL=sqlite:./data/toksuan-dev.db
OPENAI_API_KEY=sk-your-openai-key
EOF
cd apps/gateway && bun install && bun run dev &

# Dashboard env (separate terminal)
cat > apps/dashboard/.env.local <<'EOF'
DATABASE_URL=sqlite:../gateway/data/toksuan-dev.db
TOKENSMART_AUTH_ENABLED=0
EOF
cd apps/dashboard && bun install && WATCHPACK_POLLING=true bun run dev
```

### Verify your install

Three scripts validate the install end-to-end, from offline → live gateway
→ dashboard data:

```bash
# 1. Pure-module preview (no gateway, no DB) — see what context compression
#    does to representative inputs (JSON arrays, git diff, stack traces,
#    NDJSON logs, ...).
cd apps/gateway && bun run preview:tool-compress

# 2. Single-request diagnostic — 5-station check (gateway up, env flag,
#    response header, DB tag, dashboard pointer).
./apps/gateway/scripts/diagnose-tool-compress.sh

# 3. Multi-shape end-to-end demo — sends one realistic tool message per
#    recognised content shape, prints per-call savings and a rolled-up
#    aggregate matching what the dashboard hero card renders.
cd apps/gateway && bun run demo:tool-compress
```

## Integrations

TokSuan works anywhere you can set an OpenAI-compatible `base_url`.

| Tool | Guide |
|---|---|
| OpenClaw | [`examples/openclaw/`](examples/openclaw/) |
| Hermes Agent | [`examples/hermes-agent/`](examples/hermes-agent/) |
| OpenAI SDK | [`docs/integrations/openai-sdk.md`](docs/integrations/openai-sdk.md) |
| Vercel AI SDK | [`docs/integrations/vercel-ai-sdk.md`](docs/integrations/vercel-ai-sdk.md) |
| LangChain | [`docs/integrations/langchain.md`](docs/integrations/langchain.md) |
| Cursor | [`docs/integrations/cursor.md`](docs/integrations/cursor.md) |
| Cline | [`docs/integrations/cline.md`](docs/integrations/cline.md) |
| Continue | [`docs/integrations/continue.md`](docs/integrations/continue.md) |
| Dify | [`docs/integrations/dify.md`](docs/integrations/dify.md) |

## Architecture

```text
agent / SDK
   |
   | OpenAI-compatible request
   v
TokSuan Gateway
   - auth
   - budget and loop checks
   - routing / shadow / failover
   - provider resolution
   - cost calculation
   |
   v
upstream model provider

Gateway -> Postgres ledger -> Dashboard
```

## Security And Data

- Provider API keys are encrypted at rest.
- Env master-key encryption is supported for simple/self-hosted installs.
- AWS KMS and GCP KMS envelope encryption are supported for production use.
- API keys are shown once and stored hashed.
- Request-body retention is configurable.
- Hosted does not add a token spread; customers keep the provider relationship.
- TokSuan does not replace least-privilege infrastructure controls. Use
  read-only database roles, scoped cloud credentials, sandboxes, and backups for
  destructive action safety.

Read [`SECURITY.md`](SECURITY.md),
[`docs/trust/agent-action-boundary.md`](docs/trust/agent-action-boundary.md),
[`docs/trust/dpa-template.md`](docs/trust/dpa-template.md), and
[`docs/trust/sub-processors.md`](docs/trust/sub-processors.md) for the public
trust package.

## Open-Source Boundary

TokSuan open-sources the request-path trust boundary: gateway runtime,
dashboard, budgets, routing decisions, receipts, key handling, and self-host
training from local traffic.

Hosted policy-generation operations, benchmark runners, private eval data,
cross-customer routing intelligence, abuse/fraud controls, and deployment
runbooks are not part of the public repository. The shipped
`baseline-policy.json` remains inspectable, but its public provenance is
abstracted as `public_agent_eval_mix`.

See [`docs/trust/open-source-boundary.md`](docs/trust/open-source-boundary.md)
for the exact boundary.

## Pricing

TokSuan is open-core. You can self-host the Apache-2.0 code, or use the
hosted SaaS at [tokensmt.com](https://tokensmt.com).

Hosted pricing is flat-fee and BYO provider keys. TokSuan does **not** take a
spread on model tokens. Use the [savings estimator](https://tokensmt.com/estimate)
to check whether optimization is worth it for your current spend.

## Repository Layout

```text
apps/gateway/      Bun + Hono gateway
apps/dashboard/    Next.js dashboard
migrations/        Postgres migrations
migrations-sqlite/ SQLite dev/trial migrations
docs/integrations/ SDK and tool guides
docs/trust/        DPA template and sub-processors
examples/          Runnable integration examples
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues should be reported
privately through GitHub's vulnerability reporting flow, not opened as public
issues.

## Name

"Tok" points to LLM tokens, the unit of model cost. "Suan" is for calculation
and accounting. TokSuan has nothing to do with cryptocurrency or blockchain
tokens.
