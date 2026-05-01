# Example: Next.js chat through TokSuan

A minimal Next.js 15 + Vercel AI SDK chat that proxies through TokSuan instead
of hitting OpenAI directly. ~50 lines of code.

## What this demonstrates

- Drop-in `base_url` swap (one line) routes everything through TokSuan
- `x-ts-tag` per-request header for cost attribution (`feature=chat,user=$id`)
- saved-money receipts in the dashboard: asked model, landed model, actual
  cost, and saved cost
- Streaming SSE works end-to-end — `useChat()` doesn't know TokSuan exists
- The dashboard's "Spend by tag" card will populate as users chat

## Run it

The example reads `TOKENSMART_BASE_URL` + `TOKENSMART_API_KEY` from env,
so the exact same code works against local dev, self-hosted prod, or
hosted tokensmt.com — you just point it at a different URL + key.

### Path A — local dev (you're hacking on the gateway)

```bash
# 1. From the TokSuan repo root, start the gateway:
cd apps/gateway && bun install && bun run dev   # → :8787

# 2. In a new terminal, run this example:
cd examples/nextjs-chat
bun install            # or npm install
cat > .env.local <<EOF
TOKENSMART_BASE_URL=http://localhost:8787/v1
TOKENSMART_API_KEY=tokensmart-dev-key
EOF
bun run dev            # → :3001
```

Open http://localhost:3001 and send a message. Then open the TokSuan
dashboard at http://localhost:3000 — the turn appears in **Latest savings
receipt**, **Recent requests**, and **Spend by tag**.

### Path B — hosted tokensmt.com (you're a SaaS customer)

```bash
# Mint an API key at https://tokensmt.com/projects, then:
cd examples/nextjs-chat
bun install
cat > .env.local <<EOF
TOKENSMART_BASE_URL=https://gateway.tokensmt.com/v1
TOKENSMART_API_KEY=ts_<paste-your-key-here>
EOF
bun run dev            # → :3001
```

Observed requests land under your account on https://tokensmt.com. Your
BYO provider key (configured at /settings) is what actually calls OpenAI /
Anthropic — so the upstream bill stays with you, not with us.

### Path C — your own self-host

Same as Path A, but swap `http://localhost:8787/v1` for your gateway's
public URL (e.g. `https://gateway.internal.example.com/v1`) and use a
`ts_` key minted from your dashboard at `/projects`.

## Files

- `package.json` — minimal deps (next, react, ai, @ai-sdk/openai)
- `app/api/chat/route.ts` — server route that proxies through TokSuan
- `app/page.tsx` — chat UI using `useChat()`
- `app/layout.tsx` — root layout
- `next.config.mjs` — empty config

## Wire-it-up summary (the only TokSuan-specific bit)

```typescript
// app/api/chat/route.ts
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const tokensmart = createOpenAI({
  baseURL: process.env.TOKENSMART_BASE_URL!,        // http://localhost:8787/v1
  apiKey: process.env.TOKENSMART_API_KEY!,          // ts_... or tokensmart-dev-key
});

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = await streamText({
    model: tokensmart("gpt-4o-mini"),
    messages,
    headers: {
      "x-ts-tag": `app=nextjs-chat-example,feature=chat`,
    },
  });
  return result.toDataStreamResponse();
}
```

That's it. Three additions vs a vanilla OpenAI Vercel-AI-SDK setup:
- `baseURL` → TokSuan
- `apiKey` → your TokSuan key, not your OpenAI key
- `headers["x-ts-tag"]` → cost attribution
