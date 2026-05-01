# Vercel AI SDK → TokSuan

The Vercel AI SDK's `@ai-sdk/openai` provider speaks OpenAI chat completions. Point it at
TokSuan and you keep `streamText` / `generateText` / `useChat` exactly as-is.

## Install

```bash
npm install ai @ai-sdk/openai
# or
bun add ai @ai-sdk/openai
```

## Configure the provider

```typescript
import { createOpenAI } from "@ai-sdk/openai";

export const toksuan = createOpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: process.env.TOKENSMART_API_KEY!,        // ts_...
  // Optional: tag every request from this app
  headers: {
    "x-ts-tag": "app=production,service=chat-api",
  },
});
```

## `generateText` (one-shot)

```typescript
import { generateText } from "ai";

const result = await generateText({
  model: toksuan("gpt-5.2"),                   // TokSuan may auto-route this
  messages: [
    { role: "user", content: "Say hello in 5 words" },
  ],
});

console.log(result.text);
console.log(result.usage);
```

## `streamText` (chat UI)

Works in Next.js Route Handlers and Server Actions:

```typescript
// app/api/chat/route.ts
import { streamText } from "ai";
import { toksuan } from "@/lib/toksuan";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = await streamText({
    model: toksuan("gpt-4o-mini"),
    messages,
    // Per-request tagging — overrides provider-level tags
    headers: {
      "x-ts-tag": `app=production,user=${getUserId(req)}`,
    },
  });

  return result.toDataStreamResponse();
}
```

## Frontend with `useChat`

No change. The frontend doesn't know TokSuan exists — it just talks to your API route.

```tsx
// app/chat/page.tsx
"use client";
import { useChat } from "ai/react";

export default function Chat() {
  const { messages, input, handleSubmit, handleInputChange } = useChat();

  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => <div key={m.id}>{m.role}: {m.content}</div>)}
      <input value={input} onChange={handleInputChange} />
    </form>
  );
}
```

## Use a TokSuan prompt template

Reference a dashboard-managed template via the `x-ts-template` header.
TokSuan substitutes `{{var}}` placeholders server-side and prepends
the rendered body as a system message, so your application code doesn't
need to maintain system prompts in source.

```typescript
import { generateText } from "ai";

const result = await generateText({
  model: toksuan("gpt-4o-mini"),
  messages: [{ role: "user", content: "Summarize this earnings call" }],
  headers: {
    // Pin a version with `@N`; drop the pin to track `current_version`.
    "x-ts-template": "customer-support@3",
    // Tiny vars can ride along the header as JSON. For large / multi-line
    // values, prefer the `providerOptions` path below.
    "x-ts-template-vars": JSON.stringify({ tone: "concise" }),
  },
});
```

For large or multi-line variables, use the Vercel AI SDK's
`providerOptions.openai.body` escape hatch (available via
`@ai-sdk/openai` ≥ 1.0) to pass the `ts_template_vars` field straight
through to the request body — TokSuan reads it and the header-based
vars are merged on top of it.

When both sources define the same key, the header wins. A missing
variable leaves the literal `{{var}}` in the rendered text so you can
spot it in the dashboard instead of getting a silent 400.

Template-driven requests auto-tag as `template=<name>` +
`template_version=<N>`; the dashboard's "Spend by tag" card shows cost
per template version out of the box.

## Function calling / tools

```typescript
import { generateText, tool } from "ai";
import { z } from "zod";

const result = await generateText({
  model: toksuan("gpt-4o"),
  messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
  tools: {
    getWeather: tool({
      description: "Get the current weather for a city",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        return { temperature: 22, conditions: "sunny" };
      },
    }),
  },
});
```

TokSuan preserves `tools` / `tool_choice` end-to-end. The loop detector also factors
the tool definitions into its fingerprint so a flapping tool-call retry counts as a loop.

## What you get for free

- Per-request cost recorded in `micro_cents`
- Loop detection (your `useChat` retry storm gets capped at 10 calls / 5 min by default)
- Auto-routing if you set up routing rules — `gpt-5.2` becomes `gemini-flash-lite` for simple prompts
- Anthropic auto cache_control if you happen to use `claude-*` models
- `x-ts-tag` header → "Spend by tag" card in the dashboard

## Troubleshooting

- **Streaming hangs in production** — make sure your hosting platform doesn't buffer SSE. The gateway sends `X-Accel-Buffering: no` but reverse proxies sometimes override.
- **Token counts are 0 in the dashboard** — your provider doesn't honor `stream_options: { include_usage: true }`. OpenAI / DeepSeek / Qwen do; Doubao sometimes doesn't.
