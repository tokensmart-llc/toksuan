# OpenClaw → TokSuan

[OpenClaw](https://openclaw.ai) is a local-first personal AI assistant that runs on your own
devices and answers across the messaging surfaces you already use. It's the canonical
long-running, multi-session, tool-using agent — exactly the workload TokSuan's session-aware
ledger and reservation gates were built for.

If you point OpenClaw's gateway at TokSuan, you get four things for free:

- **Loop detector** stops a stuck agent from burning a weekend's spend on identical prompts
- **Budget + plan reservations** pre-deduct each turn's worst-case cost atomically, so 20
  parallel tool calls can't all sneak past the same "current spend < limit" check
- **Per-session, per-turn rollups** in the dashboard's [`/agents`](#per-agentsession-rollups)
  view — see exactly which lobster claw cost what
- **`X-Tokensmart-Request-Id` on every response** so OpenClaw can deep-link a specific call
  back to the dashboard's request-detail page when something goes wrong

Configuration is one line: change OpenClaw's LLM `base_url` to TokSuan and ship the four
attribution headers on every chat completion.

---

## 1. Point OpenClaw at TokSuan

OpenClaw uses any OpenAI-compatible upstream. In your `~/.openclaw/openclaw.json` (or the
equivalent env / config block your host wires up), set the model provider's base URL and key
to TokSuan:

```json5
{
  agent: {
    model: "openai/gpt-4o", // or any model TokSuan routes
  },
  // Adjust the field name to match whatever OpenClaw exposes for
  // "OpenAI base URL override" in the version you run — check
  // `openclaw doctor` if unsure.
  providers: {
    openai: {
      base_url: "http://localhost:8787/v1",      // self-hosted gateway
      // base_url: "https://gateway.tokensmt.com/v1",  // hosted SaaS
      api_key_env: "TOKENSMART_API_KEY",
    },
  },
}
```

```bash
export TOKENSMART_API_KEY="ts_your_project_key_here"
openclaw gateway --port 18789
```

That's it for the wire-up. Every chat completion OpenClaw fires now goes through TokSuan.
The next sections cover what to add so the dashboard becomes useful instead of an opaque
firehose.

---

## 2. The four well-known attribution headers

TokSuan promotes four request headers to first-class status in the request ledger and the
`/agents` view. These are stable contracts — TokSuan commits to never repurposing these
keys.

| Header | What it means | Example value |
|---|---|---|
| `x-ts-agent` | Which agent binary made the call | `openclaw` |
| `x-ts-session` | Caller-defined session / conversation id | `claw_2026-04-23_telegram_42` |
| `x-ts-turn` | Caller-defined turn id within the session | `7` |
| `x-ts-channel` | Coarse-grained source: `repl`, `ide`, `cron`, channel name | `telegram` |

OpenClaw should set **all four** on every chat completion request. The dashboard rolls up
sessions only when both `x-ts-agent` AND `x-ts-session` are present, and the per-turn timeline
becomes useful once `x-ts-turn` is also there. `x-ts-channel` is optional but recommended —
makes it trivial to compare WhatsApp vs iMessage vs cron-driven traffic.

You can ALSO send the freeform `x-ts-tag` header for additional dimensions (`feature=`,
`team=`, `user=` ...). Well-known headers win over same-named freeform pairs:

```
x-ts-agent: openclaw
x-ts-session: claw_telegram_42
x-ts-turn: 7
x-ts-channel: telegram
x-ts-tag: skill=todo,workspace=personal,model_thinking=high
```

---

## 3. Where to set the headers in OpenClaw

OpenClaw's LLM call site needs to thread per-turn metadata into the OpenAI-compatible request.
The exact integration point depends on which OpenClaw release you run, but the canonical
shape is:

### Pattern A — set per-session defaults at agent boot

Use this when OpenClaw spins up one OpenAI client instance per session (the common case).

```typescript
// pseudocode — adapt to your OpenClaw build's HTTP plumbing
import OpenAI from "openai";

function clientForSession(sessionId: string, channel: string) {
  return new OpenAI({
    baseURL: "http://localhost:8787/v1",
    apiKey: process.env.TOKENSMART_API_KEY,
    defaultHeaders: {
      "x-ts-agent": "openclaw",
      "x-ts-session": sessionId,
      "x-ts-channel": channel,
      // Stable across the session; turn id rotates per request.
    },
  });
}
```

### Pattern B — stamp the turn id per request

Most OpenAI SDKs accept a per-request header bag — pass `turn` there so it stays accurate
across an evolving session.

```typescript
const turn = state.turn_index; // OpenClaw's per-turn counter
const response = await client.chat.completions.create(
  {
    model: "gpt-4o",
    messages: state.messages,
    tools: state.tools,
  },
  {
    headers: {
      "x-ts-turn": String(turn),
    },
  }
);
```

### Pattern C — single curl smoke test

Useful when you just want to prove the wire-up works before touching OpenClaw code:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer ${TOKENSMART_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "x-ts-agent: openclaw" \
  -H "x-ts-session: smoketest_$(date +%s)" \
  -H "x-ts-turn: 1" \
  -H "x-ts-channel: cli" \
  -i \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hi in five words."}]
  }'
```

The `-i` shows response headers — look for:

```
X-Request-Id: 8a4e...
X-Tokensmart-Request-Id: 8a4e...
```

That UUID **is** the row id of the request in TokSuan's ledger. Keep reading for what to
do with it.

---

## 4. Reading the request id back into OpenClaw

Every TokSuan response — both non-streaming JSON and SSE streams — carries
`X-Request-Id` and `X-Tokensmart-Request-Id` (identical values; two header names because
some clients only sniff one or the other). The id is pre-allocated BEFORE the upstream call
starts, so you get it on the very first byte even when streaming.

OpenClaw should capture it and stash it in its session log:

```typescript
const response = await client.chat.completions
  .with({ stream: true })
  .create({ /* ... */ });

const requestId = response.headers?.get("x-toksuan-request-id");
session.log.append({
  turn,
  toksuan_request_id: requestId,
  // ... rest of OpenClaw's per-turn record
});
```

When something goes sideways ("the agent answered nonsense on turn 12"), your bug report
becomes a one-click link:

```
https://gateway.tokensmt.com/requests/<requestId>
```

…which lands on the full request body, response body, model picked, real cost, latency, and
which routing / failover decisions fired.

---

## 5. Per-agent / session rollups

Once OpenClaw is sending the four headers, open
[`/agents`](http://localhost:3000/agents) in the dashboard. You'll see one row per
`(agent, session)` pair, with:

- **Turns** — distinct `x-ts-turn` values + total request count
- **Spend** — real micro-cents charged across the session
- **Tokens** in / out, separated
- **p50 / p95 latency** — how long the model actually took
- **Tool / Err / Loop / Budget** — counts of tool-using turns, upstream errors,
  loop-detected blocks, budget-exceeded blocks

Click any row to see the chronological timeline of every turn in that session — model picked,
status, cost, latency, whether tools were declared, the upstream error string when it
failed, and a deep-link to the full request payload.

This is the view to bookmark. When OpenClaw's daily cost graph spikes, this page tells you
within five seconds whether it's "one runaway session" or "100 normal sessions".

---

## 6. Streaming

OpenClaw's voice mode and live Canvas typically use streaming. TokSuan's SSE pass-through:

- Stamps the same `X-Request-Id` / `X-Tokensmart-Request-Id` on the response **before** the
  body starts flowing, so you can capture it from the response object on stream open
- Retries on **initial connect** failures only. Once SSE bytes are emitted to OpenClaw the
  retry layer steps aside — silently retrying a partially-streamed response would
  observably corrupt OpenClaw's state
- Persists a compact summary (token counts, finish reason) on the request row instead of
  the full reconstructed text — keeps the ledger lean for chatty agents

If you need full response inspection in the dashboard, send the same prompt non-streaming
once. The cached response will surface the entire body on the request-detail page.

---

## 7. Recommended caps for an OpenClaw workload

OpenClaw turns are typically token-heavy (large system prompts, multi-tool definitions,
multi-modal context). Two enforcement layers worth setting:

### Project budget — protects against a runaway session

Open the project at `/projects/[id]` and set a daily cap. Suggested starting points:

| Workload | Daily cap |
|---|---|
| Personal use, mostly text | $5 / day |
| Personal use with voice + canvas | $15 / day |
| Multi-channel home assistant on cheap models | $3 / day |
| Production / multi-user OpenClaw fleet | $50–200 / day |

The reservation layer (added in v0.4) means a 20-parallel-tool-call burst can't sneak past
the cap by passing the gate before any of them write their finalized cost — they all see
each other's pending reservations.

### Plan tier — protects against a runaway *user*

If you run hosted TokSuan, the Free / Pro / Team plan caps apply per-user across every
project they own. The dashboard's `/billing` page shows the active limits.

### Loop detector — always on

Threshold defaults to 10 identical fingerprints in 5 minutes → 403 with a structured error
body OpenClaw should treat as terminal (NOT auto-retried). The loop window is now durable
across gateway restarts (lives in Postgres / SQLite, not just process memory), so a stuck
OpenClaw session that triggers a gateway restart still hits the cap when it resumes.

---

## 8. Troubleshooting

| OpenClaw symptom | TokSuan cause | What to do |
|---|---|---|
| Response status 403 with `code: "loop_detected"` | OpenClaw fired the same `(model, prompt-head, tools)` fingerprint 10+ times in 5 min. **Working as intended.** | Cancel the OpenClaw session. Inspect the most recent few requests on `/agents/[agent]/[session]` — the timeline shows what model was picked and where it got stuck. |
| Response status 429 with `code: "budget_exceeded"` | Project daily / monthly cap reached, including in-flight reservations. | Bump the budget at `/projects/[id]` if intentional, or wait for the period rollover (`Retry-After` header gives the exact seconds). |
| Response status 402 with `code: "plan_limit_exceeded"` | User's plan-tier cap (e.g. Free $1/24h) hit. | Upgrade at `/billing`, or self-host (no plan caps in self-hosted mode). |
| Response status 502 with `Upstream provider request failed` | Provider was down even after retry + cross-provider failover. | Check the gateway logs; configure `TOKENSMART_FAILOVER_MAP` to add a fallback model for your primary. |
| `agents` view is empty even though OpenClaw is running | Headers not being sent. | Verify with `curl -i` that `x-ts-agent` / `x-ts-session` reach the gateway. Both are required for a session to appear; partial tagging is hidden on purpose to avoid noisy `(NULL, "s_42")` buckets. |
| Request row's `reservation_basis` tag shows `family_max` or `global_max` | TokSuan didn't have an exact price for this model in its pricing table — used the family worst case × 1.5 safety multiplier as the reservation amount. | Add the model to `apps/gateway/src/pricing.ts` (or wait for the next pricing refresh PR). The actual ledger cost is unaffected — only the up-front reservation was a guess. |

---

## 9. What you get for free

- Per-call cost in `micro_cents` (sub-cent precision)
- **Loop detector** — durable across restarts, the canonical defense against a stuck agent
- **Budget + plan reservations** — atomic pre-deduction, so concurrent agent turns can't overshoot
- **`/agents` view** — per-session, per-turn rollup of cost / tokens / latency / tools / errors
- **`X-Tokensmart-Request-Id`** on every response, deep-linkable to `/requests/[id]`
- Auto-routing — `gpt-5.2` may become a cheaper model for trivial summarize calls
- Anthropic auto `cache_control` for Claude models — typically 30–60% savings on long sessions
- `x-ts-tag` for additional cost-attribution dimensions in the dashboard

---

## 10. Verify it's all working

After a few minutes of OpenClaw activity:

1. Open `http://localhost:3000/agents` — your active sessions should appear
2. Click into a session — every turn shows up in chronological order, with cost & latency
3. From any turn row, click "view →" — opens `/requests/[id]` with the full request body
4. Send any failing turn's `x-toksuan-request-id` to a teammate as a debug breadcrumb
