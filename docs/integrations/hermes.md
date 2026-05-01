# Hermes-Agent → TokSuan

[Hermes-Agent](https://github.com/NousResearch/hermes-agent) (NousResearch,
released Feb 2026) is a multi-platform autonomous agent that runs across
20+ messaging surfaces (Telegram, Discord, Slack, WhatsApp, Signal, the
TUI, ACP-based IDEs, cron jobs...) on top of any OpenAI-compatible model
endpoint. It's the canonical long-running, multi-session, tool-using
agent — exactly the workload TokSuan's session-aware ledger and
reservation gates were built for.

If you point Hermes' `model.base_url` at TokSuan, you get four things
for free:

- **Loop detector** stops a stuck Hermes turn from burning a weekend's spend
  on identical prompts (durable across gateway restarts)
- **Budget + plan reservations** pre-deduct each turn's worst-case cost
  atomically, so concurrent tool calls or fan-out subagents can't all
  sneak past the same "current spend < limit" check
- **Per-session, per-turn rollups** in the dashboard's
  [`/agents`](#5-per-agent--session-rollups) view — one row per
  `(hermes, <platform>, <session_id>)` triple
- **`X-Tokensmart-Request-Id` on every response** so Hermes (and your
  bug reports) can deep-link a specific turn back to the dashboard's
  request-detail page

Configuration is one section in `~/.hermes/config.yaml` and one line in
`~/.hermes/.env`. The end-user walkthrough lives in
[`examples/hermes-agent/`](../../examples/hermes-agent/); this doc covers
the agent/session header contract and what to wire if you're integrating
at the code level.

---

## 1. Point Hermes at TokSuan

Hermes treats any OpenAI-compatible upstream as `provider: custom` (see
[Hermes' AI Providers
guide](https://hermes-agent.nousresearch.com/docs/integrations/providers/)).
The canonical fragment for `~/.hermes/config.yaml`:

```yaml
model:
  default: gpt-4o            # any model TokSuan can resolve
  provider: custom
  base_url: http://localhost:8787/v1     # self-hosted gateway
  # base_url: https://gateway.tokensmt.com/v1  # hosted SaaS
  key_env: TOKENSMART_API_KEY
```

And in `~/.hermes/.env`:

```bash
TOKENSMART_API_KEY=ts_your_project_key_here
```

`key_env:` is the documented path around the known
`provider: custom` + inline `api_key:` issue (Hermes #12239) — it also
keeps the secret out of `config.yaml`, which gets committed to git in
many setups.

That's it for the wire-up. Every chat completion Hermes fires now goes
through TokSuan. The next sections cover what to add so the dashboard
becomes useful instead of an opaque firehose.

---

## 2. The four well-known attribution headers

TokSuan promotes four request headers to first-class status in the
request ledger and the `/agents` view. These are stable contracts —
TokSuan commits to never repurposing these keys.

| Header | What it means | Example value |
|---|---|---|
| `x-ts-agent` | Which agent binary made the call | `hermes` |
| `x-ts-session` | Caller-defined session / conversation id | Hermes' `session_id` |
| `x-ts-turn` | Caller-defined turn id within the session | `7` |
| `x-ts-channel` | Coarse-grained source: Hermes' `platform` value | `telegram` |

Hermes' `AIAgent.__init__` already takes both `platform` (`"cli"`,
`"telegram"`, `"discord"`, `"slack"`, `"tui"`, ...) and `session_id`, so
you don't need to invent new identifiers — pass them straight through.
The dashboard rolls up sessions only when both `x-ts-agent` AND
`x-ts-session` are present, and the per-turn timeline becomes useful
once `x-ts-turn` is also there.

You can ALSO send the freeform `x-ts-tag` header for additional
dimensions (`profile=`, `skill=`, `user=`, ...). Well-known headers win
over same-named freeform pairs:

```
x-ts-agent: hermes
x-ts-session: hermes_2026-04-26_telegram_42
x-ts-turn: 7
x-ts-channel: telegram
x-ts-tag: profile=home,skill=todo,user=u_alice
```

---

## 3. Where to set the headers in Hermes

Hermes has a stable plugin surface for cross-cutting request mutation.
The canonical hooks are documented in
[`AGENTS.md`](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
under "General plugins":

```
pre_tool_call, post_tool_call,
pre_llm_call, post_llm_call,
on_session_start, on_session_end
```

`pre_llm_call` is the right place to inject the four headers — it fires
once per outbound chat completion, with access to the agent state
(session id, platform, turn counter).

### Pattern A — drop-in plugin (recommended)

The example directory ships
[`toksuan_plugin.py`](../../examples/hermes-agent/toksuan_plugin.py)
as a starter. Install:

```bash
mkdir -p ~/.hermes/plugins/toksuan
cp toksuan_plugin.py ~/.hermes/plugins/toksuan/__init__.py
hermes plugins list   # confirm toksuan is discovered
```

Sketch:

```python
def register(ctx):
    ctx.add_hook("on_session_start", _reset_turn_counter)
    ctx.add_hook("pre_llm_call", _stamp_headers)

def _stamp_headers(*args, **kwargs):
    request = _find_request_kwargs(args, kwargs)
    sid = _session_id(kwargs.get("session"))
    platform = _attr(kwargs.get("agent"), "platform") or "cli"
    turn = _bump_turn(sid)
    request.setdefault("extra_headers", {}).update({
        "x-ts-agent": "hermes",
        "x-ts-channel": platform,
        "x-ts-session": sid or "unknown",
        "x-ts-turn": str(turn),
    })
```

The shipped file in `examples/` is more defensive (handles version drift
in `pre_llm_call`'s arg shape) — copy that one rather than this sketch.

### Pattern B — wrap the OpenAI client

If you can't drop in a plugin (e.g., you're embedding `AIAgent` directly
into a larger Python process), pass an OpenAI client with default
headers:

```python
from openai import OpenAI
from hermes_agent import AIAgent

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key=os.environ["TOKENSMART_API_KEY"],
    default_headers={
        "x-ts-agent": "hermes",
        "x-ts-channel": "embedded",
        # session + turn vary per turn — set per-call via extra_headers
    },
)

agent = AIAgent(
    base_url="http://localhost:8787/v1",
    api_key=os.environ["TOKENSMART_API_KEY"],
    api_mode="chat_completions",
    model="gpt-4o",
    platform="embedded",
    session_id=current_session_id,
    # If your Hermes build accepts a pre-built client, hand it in here.
    # Otherwise the constructor builds one from base_url/api_key.
)
```

### Pattern C — single curl smoke test

Useful when you just want to prove the wire-up works before touching
config:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer ${TOKENSMART_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "x-ts-agent: hermes" \
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

That UUID **is** the row id of the request in TokSuan's ledger.

The example directory packages this as
[`smoke.sh`](../../examples/hermes-agent/smoke.sh).

---

## 4. Reading the request id back into Hermes

Every TokSuan response — both non-streaming JSON and SSE streams —
carries `X-Request-Id` and `X-Tokensmart-Request-Id` (identical values;
two header names because some clients only sniff one or the other). The
id is pre-allocated BEFORE the upstream call starts, so you get it on
the very first byte even when streaming.

The natural place to capture it is `post_llm_call`:

```python
def register(ctx):
    ctx.add_hook("post_llm_call", _stash_request_id)

def _stash_request_id(*args, **kwargs):
    response = kwargs.get("response") or _first_response(args)
    if response is None:
        return
    headers = getattr(response, "response_headers", None) or getattr(response, "headers", None)
    if headers:
        rid = headers.get("x-toksuan-request-id") or headers.get("x-request-id")
        if rid:
            session = kwargs.get("session")
            session.metadata.setdefault("toksuan_request_ids", []).append(rid)
```

When something goes sideways ("the agent answered nonsense on turn 12"),
your bug report becomes a one-click link:

```
https://gateway.tokensmt.com/requests/<requestId>
```

…which lands on the full request body, response body, model picked, real
cost, latency, and which routing / failover decisions fired.

---

## 5. Per-agent / session rollups

Once Hermes is sending the four headers, open
[`/agents`](http://localhost:3000/agents) in the dashboard. You'll see
one row per `(agent, session)` pair, with:

- **Turns** — distinct `x-ts-turn` values + total request count
- **Spend** — real micro-cents charged across the session
- **Tokens** in / out, separated
- **p50 / p95 latency** — how long the model actually took
- **Tool / Err / Loop / Budget** — counts of tool-using turns, upstream
  errors, loop-detected blocks, budget-exceeded blocks

Click any row to see the chronological timeline of every turn in that
session — model picked, status, cost, latency, whether tools were
declared, the upstream error string when it failed, and a deep-link to
the full request payload.

This is the view to bookmark. When Hermes' daily cost graph spikes, this
page tells you within five seconds whether it's "one runaway session" or
"100 normal sessions across five Telegram chats".

### Multi-profile setups

If you run several Hermes profiles (`hermes -p coder`, `hermes -p home`,
...), the cleanest pattern is one TokSuan project per profile. The
`/agents` view scopes to whichever project's API key the request used,
so profile rollups stay isolated even when sessions share names.

---

## 6. Streaming, compression, and prompt caching

### Streaming

Hermes' TUI, voice gateway, and live tool feedback all use streaming.
TokSuan's SSE pass-through:

- Stamps the same `X-Request-Id` / `X-Tokensmart-Request-Id` on the
  response **before** the body starts flowing, so `pre_llm_call` /
  `post_llm_call` can capture it from the response object on stream open
- Retries on **initial connect** failures only. Once SSE bytes are
  emitted to Hermes the retry layer steps aside — silently retrying a
  partially-streamed response would observably corrupt Hermes'
  conversation history and break message-alternation invariants
- Persists a compact summary (token counts, finish reason) on the
  request row instead of the full reconstructed text — keeps the ledger
  lean for chatty multi-turn agents

If you need full response inspection in the dashboard, send the same
prompt non-streaming once. The cached response will surface the entire
body on the request-detail page.

### Compression

Hermes has its own preflight (>50% context) and gateway (>85% context)
compression layers in `agent/context_compressor.py`. These run **inside
Hermes** before TokSuan sees the request, so the gateway only ever
observes the post-compression message list. No coordination needed —
just be aware that what you see on the dashboard is the compressed shape
and that's the right thing to bill against.

### Prompt caching (Anthropic)

For Anthropic models (`claude-*`), TokSuan auto-injects
`cache_control: {type: "ephemeral"}` markers on the system prompt and
the last user/tool message. This is exactly what Hermes'
`agent/prompt_caching.py` expects. Result: typically 30-60% input-token
savings on long Hermes sessions for free, with no Hermes-side change.

For non-Anthropic models, prompt caching is provider-side and
pass-through — TokSuan doesn't touch it.

---

## 7. Recommended caps for a Hermes workload

Hermes turns are typically token-heavy (large system prompt, multi-tool
definitions, memory + persona files, fan-out subagents via
`delegate_task`). Two enforcement layers worth setting:

### Project budget — protects against a runaway session

Open the project at `/projects/[id]` and set a daily cap. Suggested
starting points:

| Workload | Daily cap |
|---|---|
| Solo CLI / IDE | $5 / day |
| Heavy personal use, multi-channel gateway | $15 / day |
| Always-on home assistant + cron | $10–30 / day |
| Multi-profile / team Hermes fleet | $50–200 / day |

The reservation layer (added in v0.4) means a 20-parallel-tool-call
burst — typical when `delegate_task(tasks=[...])` fans out — can't sneak
past the cap by passing the gate before any of them write their
finalized cost. They all see each other's pending reservations.

### Plan tier — protects against a runaway *user*

If you run hosted TokSuan, the Free / Pro / Team plan caps apply
per-user across every project they own. The dashboard's `/billing` page
shows the active limits.

### Loop detector — always on

Threshold defaults to 10 identical fingerprints in 5 minutes → 403 with
a structured error body Hermes' `fallback_providers` chain treats as
terminal (NOT auto-retried). The loop window is now durable across
gateway restarts (lives in Postgres / SQLite, not just process memory),
so a stuck Hermes session that triggers a gateway restart still hits
the cap when it resumes.

### Hermes-side iteration budget

Independently, Hermes' `IterationBudget` (default 90 turns,
configurable via `agent.max_turns`) caps how many tool-calling
iterations a single user message can spawn before Hermes itself stops.
This is your inner safety net; TokSuan's loop detector + project
budget are the outer ones. Both are useful.

---

## 8. Fallback model

Hermes' `fallback_model` swaps providers mid-session on 429 / 5xx /
auth blips. Pointing **both** the primary and the fallback at TokSuan
means the fallback also benefits from routing, loop detection, and the
request ledger:

```yaml
model:
  default: gpt-4o
  provider: custom
  base_url: http://localhost:8787/v1
  key_env: TOKENSMART_API_KEY

fallback_model:
  provider: custom
  model: gpt-4o-mini
  base_url: http://localhost:8787/v1
  key_env: TOKENSMART_API_KEY
```

Configure TokSuan's own per-project failover map
(`TOKENSMART_FAILOVER_MAP`) so you have two layers: TokSuan's
provider-level failover (cross-key, cross-region) catches transient
upstream outages, and Hermes' fallback_model catches "this whole model
is busted today, give me a different one".

---

## 9. Troubleshooting

| Hermes symptom | TokSuan cause | What to do |
|---|---|---|
| Response status 403 with `code: "loop_detected"` | Hermes fired the same `(model, prompt-head, tools)` fingerprint 10+ times in 5 min. **Working as intended.** | Stop the Hermes session. Inspect the most recent few requests on `/agents/[agent]/[session]` — the timeline shows what model was picked and where it got stuck. |
| Response status 429 with `code: "budget_exceeded"` | Project daily / monthly cap reached, including in-flight reservations. | Bump the budget at `/projects/[id]` if intentional, or wait for the period rollover (`Retry-After` header gives the exact seconds). |
| Response status 402 with `code: "plan_limit_exceeded"` | User's plan-tier cap (e.g. Free $1/24h) hit. | Upgrade at `/billing`, or self-host (no plan caps in self-hosted mode). |
| Response status 502 with `Upstream provider request failed` | Provider was down even after retry + cross-provider failover. | Check the gateway logs; configure `TOKENSMART_FAILOVER_MAP` and Hermes' `fallback_model`. |
| `agents` view is empty even though Hermes is running | Headers not being sent. | Verify with `curl -i` that `x-ts-agent` / `x-ts-session` reach the gateway. Both are required for a session to appear; partial tagging is hidden on purpose. Check that `toksuan_plugin` is discovered (`hermes plugins list`). |
| `provider: custom` + `api_key:` ignored | Known Hermes issue #12239 — `api_key` inline doesn't always reach the HTTP layer. | Use `key_env: TOKENSMART_API_KEY` and put the secret in `~/.hermes/.env`. |
| Request row's `reservation_basis` tag shows `family_max` or `global_max` | TokSuan didn't have an exact price for this model in its pricing table — used the family worst case × 1.5 safety multiplier as the reservation amount. | Add the model to `apps/gateway/src/pricing.ts` (or wait for the next pricing refresh PR). The actual ledger cost is unaffected — only the up-front reservation was a guess. |

---

## 10. What you get for free

- Per-call cost in `micro_cents` (sub-cent precision)
- **Loop detector** — durable across restarts, the canonical defense
  against a stuck `IterationBudget`-bypassing turn
- **Budget + plan reservations** — atomic pre-deduction, so concurrent
  Hermes turns and `delegate_task` fan-outs can't overshoot
- **`/agents` view** — per-session, per-turn rollup of cost / tokens /
  latency / tools / errors
- **`X-Tokensmart-Request-Id`** on every response, deep-linkable to
  `/requests/[id]`
- Auto-routing — `gpt-5.2` may become a cheaper model for trivial
  summarize-this turns
- Anthropic auto `cache_control` for Claude models — typically 30–60%
  savings on long sessions, free of charge
- `x-ts-tag` for additional cost-attribution dimensions in the dashboard

---

## 11. Verify it's all working

After a few minutes of Hermes activity:

1. Open `http://localhost:3000/agents` — your active sessions should
   appear with `x-ts-agent: hermes`
2. Click into a session — every turn shows up in chronological order,
   with cost & latency
3. From any turn row, click "view →" — opens `/requests/[id]` with the
   full request body
4. Send any failing turn's `x-toksuan-request-id` to a teammate as a
   debug breadcrumb — that single value resolves to the entire turn,
   including the model picked, the routing reason, the tool schema, and
   the upstream's raw response
