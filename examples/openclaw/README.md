# Example: OpenClaw through TokSuan

This guide is for OpenClaw users who want to route their existing personal AI
assistant through TokSuan with the smallest possible change.

Goal:

1. Keep using OpenClaw as usual.
2. Change OpenClaw's OpenAI-compatible `base_url` to TokSuan.
3. Mint a TokSuan project API key.
4. Run one OpenClaw request.
5. See the saved-money receipt in the TokSuan dashboard.

For lower-level integration details, including the full agent/session header
contract, see [`docs/integrations/openclaw.md`](../../docs/integrations/openclaw.md).

---

## What this gives you

- **Spend visibility**: every OpenClaw model call lands in the TokSuan ledger.
- **Hard budgets**: set a daily/monthly cap for OpenClaw before a loop gets expensive.
- **Automatic routing**: simple prompts can land on cheaper models when the policy says it is safe.
- **Savings receipts**: see asked model, landed model, actual cost, and saved cost.
- **Optional session rollups**: if OpenClaw can send headers, `/agents` groups spend by OpenClaw session.
- **Learning routing**: TokSuan starts with a public model frontier, then can learn which models work best for your OpenClaw workload from real traffic and shadow trials.

---

## 1. Prepare TokSuan

Hosted:

1. Sign in at `https://tokensmt.com`.
2. Open **Settings → Provider keys**.
3. Add your OpenAI / Anthropic / DeepSeek / Qwen / Doubao key.
4. Open **Projects**.
5. Create a project named `openclaw-personal`.
6. Create an API key and copy the `ts_...` value.

Self-host:

1. Run the gateway and dashboard.
2. Add at least one upstream provider key in `apps/gateway/.env`, or use BYO keys in Settings.
3. Create a project in the dashboard.
4. Create an API key and copy the `ts_...` value.

Recommended: keep OpenClaw in its own TokSuan project so budgets and reports
are easy to understand.

---

## 2. Configure OpenClaw

In OpenClaw, choose its OpenAI-compatible / custom OpenAI provider and set:

Hosted:

```text
Base URL: https://gateway.tokensmt.com/v1
API key:  ts_your_project_key_here
Model:    gpt-4o, gpt-5.2, claude-..., or any model TokSuan can resolve
```

Self-host:

```text
Base URL: http://localhost:8787/v1
API key:  ts_your_project_key_here
Model:    gpt-4o, gpt-5.2, claude-..., or any model TokSuan can resolve
```

If your OpenClaw version uses a config file, adapt this example:

```jsonc
{
  "providers": {
    "openai": {
      "base_url": "http://localhost:8787/v1",
      "api_key": "ts_your_project_key_here"
    }
  },
  "agent": {
    "model": "gpt-4o"
  }
}
```

Exact field names may differ by OpenClaw version. The important parts are:

- `base_url` points to TokSuan's `/v1`.
- `api_key` is the TokSuan project key, not your OpenAI key.
- upstream provider keys stay in TokSuan Settings; OpenClaw only needs the `ts_...` project key.

See [`openclaw.tokensmart.example.jsonc`](openclaw.tokensmart.example.jsonc)
for a copyable config template.

---

## 3. Smoke-test the TokSuan key

Before changing OpenClaw, verify the TokSuan project key works.

Hosted:

```bash
export TOKENSMART_BASE_URL="https://gateway.tokensmt.com/v1"
export TOKENSMART_API_KEY="ts_your_project_key_here"
```

Self-host:

```bash
export TOKENSMART_BASE_URL="http://localhost:8787/v1"
export TOKENSMART_API_KEY="ts_your_project_key_here"
```

Then run:

```bash
curl "$TOKENSMART_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $TOKENSMART_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-ts-agent: openclaw" \
  -H "x-ts-session: smoke-openclaw" \
  -H "x-ts-turn: 1" \
  -H "x-ts-channel: cli" \
  -i \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Say hi in one short sentence."}]
  }'
```

Look for these response headers:

```text
X-Tokensmart-Request-Id: ...
X-Tokensmart-Asked-Model: ...
X-Tokensmart-Landed-Model: ...
X-Tokensmart-Routing-Reason: ...
```

Open the TokSuan dashboard. The request should appear in **Latest savings
receipt** and **Recent requests**.

---

## 4. Add OpenClaw attribution headers, if your version supports them

TokSuan works without custom headers, but these headers make the dashboard
much more useful for long-running agents:

```http
x-ts-agent: openclaw
x-ts-session: <OpenClaw session id>
x-ts-turn: <turn number>
x-ts-channel: cli
```

With these headers, TokSuan's **Agents** page can show:

- spend per OpenClaw session
- turns and request count
- tool-heavy sessions
- loop / budget / plan blocks
- the most expensive session

These headers also give TokSuan the right product semantics for agents:
different sessions/tasks can route to different models, while a single session
can be analyzed as one coherent workload. Send a stable `x-ts-session` whenever
your OpenClaw version supports it.

If your OpenClaw version cannot attach custom headers, keep using a dedicated
TokSuan project for OpenClaw. You still get budgets, routing, loop detection,
receipts, and project-level spend.

---

## 5. Set a budget for OpenClaw

OpenClaw is a long-running agent. A daily budget is the first safety rail.

Suggested starting points:

| Usage | Daily budget |
|---|---:|
| Personal text use | `$3-5/day` |
| Heavy personal use, voice, or canvas | `$10-15/day` |
| Always-on multi-channel assistant | `$10-30/day` |
| Team or multi-user OpenClaw fleet | `$50+/day` |

In TokSuan:

1. Open the `openclaw-personal` project.
2. Go to **Budgets**.
3. Set a daily cap.

When the cap is hit, TokSuan blocks new OpenClaw requests before they reach
the upstream provider.

---

## 6. Route carefully: shadow first, route later

OpenClaw is an agent. A wrong cheap-model answer can cascade into more tool
calls, so do not promote routes blindly.

Recommended flow:

1. Start with the baseline policy.
2. Add a project routing rule in `shadow` mode for a candidate cheap model.
3. Watch **Quality proof** on the dashboard.
4. Promote to `route` only when the dashboard says `Quality-checked`.

Remember:

- **Shadow success** is a background cheap-model experiment.
- Shadow failure does **not** fail the user-facing OpenClaw response.
- If shadow success is low, do not promote that route.
- TokSuan defaults to same-provider BYO complexity judging, so a user with
  only an OpenAI key does not need a Gemini key just to classify tasks.

---

## 7. How to verify it is working

After running OpenClaw for a few minutes, check:

1. Dashboard **Saved · last 30 days** has data.
2. **Latest savings receipt** shows asked model and landed model.
3. **Recent requests** contains OpenClaw calls.
4. **Agents** contains OpenClaw sessions if attribution headers are enabled.
5. The OpenClaw project page has budgets and routing rules you can control.

If nothing appears:

- Confirm OpenClaw's `base_url` points to TokSuan's `/v1`.
- Confirm the key is a TokSuan `ts_...` key.
- Confirm your upstream provider key is configured in TokSuan Settings.
- Confirm the gateway is running.

---

## FAQ

### OpenClaw still displays the original model. Did routing fail?

Not necessarily. Many clients show the configured model string, not the model
that the gateway actually called.

Trust TokSuan's:

- `X-Tokensmart-Landed-Model` response header
- response body `model`
- request row in the dashboard
- Latest savings receipt

### Does `Shadow success = 90%` mean users saw 10% failures?

No. Shadow calls are background experiments. The primary response was still
served to OpenClaw users.

Shadow success tells you whether a cheap model is safe to promote later.

### What if OpenClaw cannot send custom headers?

TokSuan still works. You lose per-session aggregation in `/agents`, but you
keep:

- spend ledger
- budgets
- loop detection
- routing
- savings receipts

Use a dedicated TokSuan project for attribution.

---

## Short version

1. Add your provider key in TokSuan Settings.
2. Create an `openclaw-personal` project.
3. Copy the `ts_...` API key.
4. Set OpenClaw's OpenAI-compatible base URL to TokSuan.
5. Run one OpenClaw request.
6. Check the TokSuan dashboard receipt.

That is the whole integration.
