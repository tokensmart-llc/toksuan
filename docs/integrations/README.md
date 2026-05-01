# Integration guides

TokSuan is an OpenAI-compatible proxy. Anything that speaks OpenAI chat completions
(which is most of the agent / LLM ecosystem in 2026) works by changing exactly one line:
your `base_url`.

## Quick reference — the magic line

| Tool | What to change |
|---|---|
| **OpenAI SDK (Python / Node)** | `OpenAI(base_url="http://localhost:8787/v1", api_key="ts_...")` |
| **Vercel AI SDK** | `createOpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "ts_..." })` |
| **LangChain (Py)** | `ChatOpenAI(openai_api_base="http://localhost:8787/v1", openai_api_key="ts_...")` |
| **LangChain (JS)** | `new ChatOpenAI({ configuration: { baseURL: "http://localhost:8787/v1" }, openAIApiKey: "ts_..." })` |
| **Cursor** | Settings → Models → custom OpenAI base URL |
| **Cline** | Settings → API Provider → OpenAI Compatible |
| **Continue.dev** | `~/.continue/config.json` → custom OpenAI provider |
| **Dify** | Model Provider → OpenAI-API-compatible |

## Per-tool guides

- **[OpenAI SDK (Python + Node)](openai-sdk.md)** — drop-in for the official OpenAI library
- **[Vercel AI SDK](vercel-ai-sdk.md)** — `streamText`, `generateText`, `useChat`
- **[LangChain](langchain.md)** — Python and JS, including LangGraph
- **[OpenClaw quickstart](../../examples/openclaw/)** — end-user guide + config template for routing OpenClaw through TokSuan
- **[OpenClaw](openclaw.md)** — local-first personal AI assistant; covers the four
  well-known agent attribution headers + per-session rollups
- **[Hermes-Agent quickstart](../../examples/hermes-agent/)** — end-user guide + `~/.hermes/config.yaml` template + drop-in plugin
- **[Hermes-Agent](hermes.md)** — NousResearch's multi-platform autonomous agent;
  covers the `provider: custom` config, the `pre_llm_call` plugin hook, fallback_model wiring, and per-session rollups across the 20+ messaging surfaces
- **[Cursor](cursor.md)** — IDE assistant
- **[Cline](cline.md)** — autonomous coding agent
- **[Continue.dev](continue.md)** — VS Code / JetBrains assistant
- **[Dify](dify.md)** — visual agent builder

## Tagging requests for cost attribution

All integrations support TokSuan's `x-ts-tag` header for per-feature / per-team / per-customer
cost attribution. The dashboard's "Spend by tag" card groups by these.

```
x-ts-tag: feature=summarization,team=growth,user=u_123
```

For long-running agents (OpenClaw, Hermes-Agent, AutoGPT-style loops, LangGraph multi-step
pipelines) TokSuan additionally promotes four headers to first-class status — they populate
the dashboard's `/agents` per-session rollup view:

```
x-ts-agent:   <agent binary, e.g. openclaw, hermes>
x-ts-session: <caller-defined session/conversation id>
x-ts-turn:    <caller-defined turn id within the session>
x-ts-channel: <coarse source: repl, ide, cron, telegram, ...>
```

See **[OpenClaw](openclaw.md)** or **[Hermes-Agent](hermes.md)** for the canonical recipes.

Each integration guide shows how to set headers in that ecosystem.

## Hosted vs self-hosted base URLs

| | base_url |
|---|---|
| Hosted SaaS | `https://gateway.tokensmt.com/v1` |
| Self-host (dev) | `http://localhost:8787/v1` |
| Self-host (prod) | wherever your gateway runs, e.g. `https://gateway.example.internal/v1` |

The API key is whatever you minted in **Projects → Create API key** (or `tokensmart-dev-key`
for the seed dev project in single-tenant mode).

## "It worked, but how do I see the saved $?"

Open the dashboard. The hero number on `/` shows 30-day savings (routing + cache). Each
request page (`/requests/[id]`) shows the per-request saving and which model was actually
called vs what the client requested.
