# TokSuan

> **AI spend control and routing for agents.**
> See every model call, cap runaway spend, and route easy work to cheaper models
> only when the receipt proves the trade worked.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh)
[![Made for agents](https://img.shields.io/badge/made%20for-AI%20agents-purple.svg)](#why-toksuan)
[![Website](https://img.shields.io/badge/website-tokensmt.com-0A66C2.svg)](https://tokensmt.com)

![TokSuan tutorial screenshot](docs/assets/toksuan-tutorial.png)

TokSuan is operated by TokenSmart LLC and sits between your agents and upstream
model providers. Keep the OpenAI-compatible request shape your tools already
use, then add spend receipts, project budgets, loop protection, and
evidence-based routing.

The core idea is simple: **See it. Cap it. Shrink it.** TokSuan is not a
cheap-model proxy. Simple turns can route to fast inexpensive models, while
hard/frontier turns keep high-quality models unless your own traffic proves a
safe downgrade.

## Watch The Tutorial

The short tutorial shows the hosted flow end to end: bring your own provider
key, create a TokSuan project key, send an agent request, inspect the receipt,
and understand how routing can reduce agent spend.

- [Watch on LinkedIn](https://www.linkedin.com/posts/pichao-wang-494773109_aiagents-llmops-aiinfrastructure-ugcPost-7458333083977547776-lwl2?utm_source=share&utm_medium=member_desktop&rcm=ACoAABtX8fABVkgbF_NMGobvnhN-MyxYrmY4wGE)
- [Watch on YouTube](https://youtu.be/ndWhjo64d-g)
- [Watch on Bilibili](https://www.bilibili.com/video/BV1baduBmELn/?spm_id_from=333.1387.homepage.video_card.click&vd_source=5fa8c3c626a489f11a0110ba86ed17f5)

## Four Steps, No Agent Rewrite

1. Add the provider key you already use, such as OpenAI, Anthropic, Google
   Gemini, DeepSeek, Qwen, or Doubao.
2. Create a TokSuan project and copy its `ts_...` project key.
3. Point your agent or SDK to `https://gateway.tokensmt.com/v1` as the
   OpenAI-compatible `base_url`.
4. Inspect the dashboard receipt for cost, latency, token usage, budget checks,
   and any routing decision.

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
| Agents need multiple model families | BYO provider keys for OpenAI, Anthropic, Google, DeepSeek, Qwen, and Doubao, with routing that sends each task to the best-fit provider |

The result is a per-request receipt:

```text
X-Tokensmart-Asked-Model: gpt-5.5
X-Tokensmart-Landed-Model: deepseek-chat
X-Tokensmart-Routing-Reason: baseline:chat:simple
X-Tokensmart-Cost-Saved-Vs-Asked-Cents: 0.940000
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

## Why Not OpenRouter?

OpenRouter gives developers access to many models behind one API. TokSuan
solves a different problem: deciding which model an agent should use for each
turn, enforcing spend controls before the upstream call, and proving what
changed afterward.

```text
OpenRouter: model access and aggregation
TokSuan: agent routing decisions, budgets, receipts, and learning policies
```

You can run TokSuan with your own OpenAI, Anthropic, Google, DeepSeek, Qwen,
or Doubao keys. Simple turns can flow to cheaper models; hard/frontier turns
stay on advanced models unless your own workload proves a safe alternative.
The more your agent runs, the more project-specific the routing can become.

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

### Dashboard

- Email OTP auth
- Projects, API keys, budgets, routing rules, alerts, audit log
- Savings receipt and 7-day value report
- Provider-key upload with encrypted storage
- Agents/session view when callers send attribution headers
- Trust page and production health posture

### Deployment

- Local dev via Docker Compose
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

### Self-host dev

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
