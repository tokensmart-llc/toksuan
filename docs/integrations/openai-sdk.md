# OpenAI SDK → TokSuan

The official OpenAI SDK (Python + Node) speaks the OpenAI chat completions protocol — which is
exactly what TokSuan proxies. **Change one line, get every TokSuan feature for free.**

## Python (`openai` package)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",        # ← TokSuan, not api.openai.com
    api_key="ts_your_project_key_here",      # ← from Projects → Create API key
)

resp = client.chat.completions.create(
    model="gpt-5.2",                             # TokSuan may auto-route to a cheaper model
    messages=[{"role": "user", "content": "Say hi"}],
)
print(resp.choices[0].message.content)
print(resp.model)   # ← shows the model TokSuan actually called (e.g. gemini-2.5-flash-lite)
```

### Streaming

Streaming works identically. TokSuan auto-injects `stream_options: { include_usage: true }`
so billing stays accurate even when the caller forgot to ask for it.

```python
stream = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Count to 5"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### Tagging requests (cost attribution)

Send the `x-ts-tag` header to attribute spend to a feature / team / user. Comma-separated
`key=value` pairs.

```python
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Summarize: ..."}],
    extra_headers={"x-ts-tag": "feature=summarization,team=growth,user=u_42"},
)
```

The dashboard's "Spend by tag" card will now break down the bill by these dimensions.

### Use a TokSuan prompt template

Store a versioned system prompt in the dashboard (`/projects/[id]/templates`) and
reference it at runtime via the `x-ts-template` header. TokSuan substitutes
`{{var}}` placeholders server-side, prepends the rendered body as a system
message, and auto-tags the request with `template=<name>` + `template_version=<N>`
so the "Spend by tag" card breaks out cost per template version.

```python
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Summarize this earnings call"}],
    extra_headers={
        # Pin a specific version; drop `@3` to use the template's current version.
        "x-ts-template": "customer-support@3",
    },
    extra_body={
        # Preferred: large / multi-line values go in the body.
        "ts_template_vars": {
            "tone": "concise, professional",
            "language": "English",
        },
    },
)
```

For tiny vars you can alternatively pass them through the header as JSON:

```python
import json
extra_headers={
    "x-ts-template": "customer-support",
    "x-ts-template-vars": json.dumps({"tone": "concise"}),
}
```

When both sources are present, the header wins on key collision. A missing
variable leaves the literal `{{var}}` in the rendered output — easy to spot
during development without breaking the request.

---

## Node / TypeScript (`openai` package)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",          // ← TokSuan
  apiKey: "ts_your_project_key_here",
});

const resp = await client.chat.completions.create({
  model: "gpt-5.2",
  messages: [{ role: "user", content: "Say hi" }],
});

console.log(resp.choices[0].message.content);
console.log(resp.model);   // shows the actually-called model
```

### Streaming

```typescript
const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Count to 5" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### Tagging requests

The Node SDK exposes per-request headers via the second argument:

```typescript
const resp = await client.chat.completions.create(
  {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Summarize: ..." }],
  },
  {
    headers: { "x-ts-tag": "feature=summarization,team=growth,user=u_42" },
  }
);
```

### Use a TokSuan prompt template

Same pattern as Python — header goes in the second-arg `headers`, and the
body gets an extra `ts_template_vars` field (TypeScript's `openai` package
accepts unknown fields on the request):

```typescript
const resp = await client.chat.completions.create(
  {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Summarize this earnings call" }],
    // @ts-expect-error — ts_template_vars is a TokSuan-only field
    ts_template_vars: {
      tone: "concise, professional",
      language: "English",
    },
  },
  {
    headers: {
      "x-ts-template": "customer-support@3",
    },
  }
);
```

Manage templates at `/projects/[id]/templates` in the dashboard — they're
per-project, versioned, and rollback-able. Template-driven requests land
under "Spend by tag" as `template=customer-support` + `template_version=3`
so you can track cost drift across template revisions.

---

## Hosted vs self-hosted

| | base_url |
|---|---|
| Hosted SaaS | `https://gateway.tokensmt.com/v1` |
| Self-host (dev) | `http://localhost:8787/v1` |
| Self-host (prod) | your domain, e.g. `https://gateway.example.com/v1` |

---

## What still works

Every OpenAI SDK feature that's part of `chat/completions`:

- ✅ `messages` (system, user, assistant, tool roles)
- ✅ `tools` / `tool_choice` (function calling)
- ✅ `response_format` (JSON mode)
- ✅ `stream` + `stream_options.include_usage`
- ✅ `temperature`, `max_tokens`, `top_p`, `seed`, `stop`, `n`
- ✅ Vision input (image URLs in `content` arrays for vision-capable models)

What we **don't** proxy yet:

- ❌ `/v1/embeddings` (planned — open an issue if you need it)
- ❌ `/v1/assistants` (Assistants API)
- ❌ `/v1/files`, `/v1/fine_tuning` (these are provider-specific control plane)
- ❌ `/v1/audio/*` (Whisper / TTS)

These all hit the upstream provider directly using your own API key — TokSuan only
intercepts chat completions. If you'd like one of them proxied for cost tracking,
[open an issue](https://github.com/tokensmart-llc/toksuan/issues).

---

## Troubleshooting

- **`401 Invalid API key`** → you're sending a TokSuan key but it doesn't exist in the DB. Mint a new one in the dashboard at `/projects/[id]`.
- **`400 Unrecognized model`** → TokSuan routes by model-name pattern. If you're using a model name we don't know about (e.g. `my-private-model`), set up a routing rule that maps it to a known provider.
- **`502 Upstream provider request failed`** → the upstream provider returned an error. TokSuan logs the full upstream message in the request detail page (`/requests/[id]`).
- **Stream cuts off mid-response** → check upstream `finish_reason`. Most likely `length` (hit `max_tokens`); raise the limit.
