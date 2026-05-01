# Dify → TokSuan

[Dify](https://dify.ai) is a visual agent / workflow builder that supports
"OpenAI-API-compatible" model providers. Routing Dify through TokSuan gives you sub-cent
budgets, per-workflow cost attribution, and the loop detector for visual agent loops.

## Configure in Dify

1. Open Dify → **Settings → Model Provider**
2. Click **Add Model Provider** → **OpenAI-API-compatible**
3. Fill in:
   - **Model Name**: any TokSuan-routable model name, e.g. `gpt-4o-mini`
   - **API Key**: `ts_your_project_key_here` (mint in TokSuan dashboard)
   - **API Endpoint URL**: `http://localhost:8787/v1` (or `https://gateway.tokensmt.com/v1`)
   - **Model Type**: `Chat`
   - **Model Context Size**: per the upstream model (e.g. 128000 for `gpt-4o`)
4. Click **Save**

Repeat for additional models you want to use (`claude-3-5-sonnet-latest`, `deepseek-chat`,
`qwen-max`, etc.).

## Use it in a workflow

In any Dify app's **Orchestrate** view → click the LLM node → pick the TokSuan-backed model.
Everything else (prompts, variables, retrievers) is unchanged.

## Per-workflow cost attribution

Dify doesn't expose per-request headers, but you can tag at the project level:

1. In TokSuan, create one project per Dify app: `dify-customer-bot`, `dify-summarizer`, etc.
2. Mint a TokSuan API key per project
3. In Dify, configure each app to use the matching key

The dashboard's per-project spend gives you exact attribution per Dify workflow without
any plumbing.

## TokSuan prompt templates + Dify — limitation

Dify's OpenAI-compatible provider config has no hook for custom request
headers, and TokSuan's runtime template registry is referenced via
the `x-ts-template` header. That makes the dashboard-managed templates
at `/projects/[id]/templates` **not directly addressable from inside a
Dify workflow**.

Dify's own philosophy covers this gap — the workflow editor IS where you
version and edit prompts. Best practice is to treat Dify as its own
prompt registry (so the system prompt lives in the Dify workflow) and
use TokSuan for what it's good at: cost tracking, budgets, loop
detection, and Anthropic cache_control. No double-bookkeeping.

If you have a downstream service that calls LLMs **outside** Dify — for
example a Node worker that handles async enrichments — that service can
use `x-ts-template` via any of the SDK guides:
[`openai-sdk.md`](./openai-sdk.md),
[`vercel-ai-sdk.md`](./vercel-ai-sdk.md),
[`langchain.md`](./langchain.md).

## Why this is high-value for Dify

Dify's visual workflows can accidentally create loops — a node that calls back to itself
based on an LLM-emitted condition. The loop detector catches this. Without TokSuan, a
broken Dify flow could drain a $1000 OpenAI account overnight.

Recommended budget per Dify app:

- Customer-facing workflow: **$10/day**
- Internal automation: **$2/day**

## Streaming + tools

Both work — Dify uses standard OpenAI chat completions with `stream: true` and `tools`,
which TokSuan proxies end-to-end including the `usage` chunk for accurate billing.

## Caveats

- Dify's embeddings (for retrievers) hit upstream directly
- If you use Dify's "Conversation Variables" with very long contexts, point it at `claude-*`
  models — TokSuan will auto-stamp `cache_control` and you'll see 30–60% savings on
  long sessions
