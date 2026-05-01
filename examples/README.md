# TokSuan examples

Minimal runnable examples demonstrating TokSuan in four of the most common
agent / app stacks. Each example assumes either:

- A self-hosted gateway at `http://localhost:8787` with `tokensmart-dev-key` available
  (run `docker compose up -d && cd apps/gateway && bun run dev` from the repo root), OR
- A hosted account at `tokensmt.com` with a project + API key minted

Pick one and substitute its URL/key into the example.

## Examples

| Directory | Stack | What it shows |
|---|---|---|
| [`nextjs-chat/`](nextjs-chat/) | Next.js 15 + Vercel AI SDK | Streaming chat UI through TokSuan, with `x-ts-tag` per-feature attribution |
| [`langgraph-agent/`](langgraph-agent/) | Python + LangGraph | An agent that loops on a tool — purpose-built to demonstrate TokSuan's loop detector firing |
| [`cursor-config/`](cursor-config/) | Cursor IDE | Step-by-step Settings configuration so Cursor routes through TokSuan |
| [`openclaw/`](openclaw/) | OpenClaw | End-user guide + config template for routing OpenClaw through TokSuan |
| [`hermes-agent/`](hermes-agent/) | NousResearch Hermes-Agent | `~/.hermes/config.yaml` snippet + drop-in plugin that stamps the four `x-ts-*` headers per turn |

## Why no Dify / LangChain / Cline example here

Those are end-user tools you configure in their own UI, not codebases. See the
matching guide in [`docs/integrations/`](../docs/integrations/) for each.
