# Example: Hermes-Agent through TokSuan

This guide is for [hermes-agent](https://github.com/NousResearch/hermes-agent)
users who want to route their existing Hermes setup through TokSuan with
the smallest possible change.

Hermes is a long-running, multi-session, tool-using agent that fans out across
20+ messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal, IDEs, the
TUI, cron jobs...). That's exactly the workload TokSuan's session-aware
ledger, loop detector, and reservation gates were built for.

Goal:

1. Keep using Hermes as usual.
2. Change Hermes's model `provider` to `custom` pointing at TokSuan's
   OpenAI-compatible endpoint.
3. Mint a TokSuan project API key.
4. Run one Hermes turn.
5. See the saved-money receipt in the TokSuan dashboard.

For lower-level integration details — including the four well-known agent
attribution headers and how to wire `x-ts-turn` per request — see
[`docs/integrations/hermes.md`](../../docs/integrations/hermes.md).

---

## What this gives you

- **Spend visibility**: every Hermes model call lands in the TokSuan ledger
  (CLI turns, gateway turns, TUI turns, cron jobs — all of them).
- **Hard budgets**: cap a runaway Hermes session before it eats a weekend's
  spend on a stuck reasoning loop.
- **Loop detector**: 10 identical fingerprints in 5 min → 403 with a
  structured error. Durable across gateway restarts.
- **Automatic routing**: simple turns can land on cheaper models when policy
  says it's safe.
- **Savings receipts**: see asked model, landed model, actual cost, saved cost.
- **Per-session rollups**: with the four `x-ts-*` headers wired, the
  dashboard's `/agents` page groups spend by Hermes platform + session id.
- **Learning routing**: TokSuan starts with a public multi-provider
  frontier, then learns which providers and models work best for your Hermes
  workload from real requests and shadow trials.

---

## 1. Prepare TokSuan

Hosted:

1. Sign in at `https://tokensmt.com`.
2. Open **Settings → Provider keys**.
3. Add your OpenAI / Anthropic / DeepSeek / Qwen / Doubao key.
4. Open **Projects**.
5. Create a project named `hermes-personal`.
6. Create an API key and copy the `ts_...` value.

Self-host:

1. Run the gateway and dashboard.
2. Add at least one upstream provider key in `apps/gateway/.env`, or use BYO
   keys in Settings.
3. Create a project in the dashboard.
4. Create an API key and copy the `ts_...` value.

Recommended: keep Hermes in its own TokSuan project so budgets and
reports are easy to read. If you also run multiple Hermes profiles
(`hermes -p coder`, `hermes -p home`, ...), give each one its own project
so the dashboard rolls up `/agents` views cleanly per profile.

---

## 2. Configure Hermes

Hermes treats any OpenAI-compatible endpoint as `provider: custom`. The
documented schema lives in [Hermes' AI Providers
guide](https://hermes-agent.nousresearch.com/docs/integrations/providers/) —
the canonical fragment is reproduced in
[`hermes.tokensmart.example.yaml`](hermes.tokensmart.example.yaml).

### Option A — `hermes config set` (no editor)

Hosted:

```bash
hermes config set model.default gpt-4o
hermes config set model.provider custom
hermes config set model.base_url https://gateway.tokensmt.com/v1
hermes config set model.key_env TOKENSMART_API_KEY
hermes config set TOKENSMART_API_KEY ts_your_project_key_here   # saved to ~/.hermes/.env
```

Self-host:

```bash
hermes config set model.default gpt-4o
hermes config set model.provider custom
hermes config set model.base_url http://localhost:8787/v1
hermes config set model.key_env TOKENSMART_API_KEY
hermes config set TOKENSMART_API_KEY ts_your_project_key_here
```

`hermes config set` automatically routes API keys to `~/.hermes/.env` and
everything else to `~/.hermes/config.yaml`.

### Option B — edit `~/.hermes/config.yaml` directly

Copy the snippet from [`hermes.tokensmart.example.yaml`](hermes.tokensmart.example.yaml)
into `~/.hermes/config.yaml` and add the API key to `~/.hermes/.env`:

```bash
echo 'TOKENSMART_API_KEY=ts_your_project_key_here' >> ~/.hermes/.env
```

### Verify

```bash
hermes config            # prints effective configuration
hermes doctor            # checks reachability
```

The `model:` section should show `provider: custom` and the TokSuan
`base_url`. `hermes doctor` should report a green check on "model endpoint
reachable".

---

## 3. Smoke-test the TokSuan key

Before launching a full Hermes session, run the curl smoke test that ships
alongside this guide:

```bash
export TOKENSMART_BASE_URL="http://localhost:8787/v1"     # or hosted URL
export TOKENSMART_API_KEY="ts_your_project_key_here"
./smoke.sh
```

Look for the response headers:

```text
X-Tokensmart-Request-Id: ...
X-Tokensmart-Asked-Model: ...
X-Tokensmart-Landed-Model: ...
X-Tokensmart-Routing-Reason: ...
```

Open the TokSuan dashboard. The request should appear in **Latest savings
receipt** and **Recent requests**.

---

## 4. Run one Hermes turn end-to-end

```bash
hermes
```

In the prompt, ask anything cheap, e.g. `summarize the last commit message`.
Hermes will fire one chat completion against TokSuan, which routes to your
upstream provider and returns the result. The dashboard's **Recent requests**
gains a row within a second.

If you'd rather not enter the interactive CLI, run a single non-interactive
turn:

```bash
hermes chat "Reply with one short sentence acknowledging this is a smoke test."
```

---

## 5. Add the four agent attribution headers (optional, recommended)

TokSuan works without custom headers — you still get spend, budgets, loop
detection, routing, and receipts. But sending these four turns the
dashboard's `/agents` page from "useless empty list" to "this is the per-turn
timeline I needed":

```http
x-ts-agent:   hermes
x-ts-channel: <hermes platform: cli | telegram | discord | slack | tui | ...>
x-ts-session: <hermes session id>
x-ts-turn:    <0-indexed counter, increments each LLM call in the session>
```

Hermes exposes a stable plugin surface for exactly this kind of cross-cutting
mutation. Drop [`tokensmart_plugin.py`](tokensmart_plugin.py) into
`~/.hermes/plugins/tokensmart/` and the four headers attach to every
outbound request automatically. See the file's docstring for the full
install + adapt-to-your-version notes.

If your Hermes build doesn't surface the plugin hook you need, you still get
spend, budgets, loop, routing, and receipts. You just lose per-session
aggregation in `/agents`.

---

## 6. Set a budget for Hermes

Hermes is a long-running agent that can run cron jobs and idle gateways for
days. A daily budget is the first safety rail.

Suggested starting points:

| Usage | Daily budget |
|---|---:|
| Solo CLI / IDE | `$3-5/day` |
| Heavy personal use, multi-channel gateway | `$10-20/day` |
| Always-on home assistant + cron | `$10-30/day` |
| Team Hermes fleet (multiple users / profiles) | `$50+/day` |

In TokSuan:

1. Open the `hermes-personal` project.
2. Go to **Budgets**.
3. Set a daily cap.

When the cap is hit, TokSuan returns 429 with `code: "budget_exceeded"` —
Hermes' fallback layer (`fallback_providers`) will pick this up and either
swap providers or surface the error to the user.

---

## 7. Route carefully: shadow first, route later

Hermes turns are typically token-heavy (large system prompt + memories +
tool schemas). A wrong cheap-model answer can cascade into many tool calls
before Hermes notices, so don't promote routes blindly.

Recommended flow:

1. Start with the baseline policy.
2. Add a project routing rule in `shadow` mode for a candidate cheap model.
3. Watch **Quality proof** on the dashboard.
4. Promote to `route` only when the dashboard says `Quality-checked`.

Remember:

- **Shadow success** is a background cheap-model experiment.
- Shadow failure does **not** fail the user-facing Hermes turn.
- If shadow success is low, do not promote that route.
- Complexity judging defaults to same-provider BYO keys. A Hermes project with
  only an Anthropic key uses a cheap Anthropic judge; a project with OpenAI and
  DeepSeek keys can explicitly choose either family.

---

## 8. Verify it is working

After running Hermes for a few minutes, check:

1. Dashboard **Saved · last 30 days** has data.
2. **Latest savings receipt** shows asked model and landed model.
3. **Recent requests** contains Hermes calls (filter by `x-ts-agent: hermes`
   if you wired the plugin).
4. **Agents** lists Hermes sessions if attribution headers are enabled.
5. The Hermes project page has budgets and routing rules you can control.

If nothing appears:

- Confirm `model.base_url` points to TokSuan's `/v1`.
- Confirm `TOKENSMART_API_KEY` is in `~/.hermes/.env` and starts with `ts_`.
- Confirm your upstream provider key is configured in TokSuan Settings.
- Confirm the gateway is running (`curl $TOKENSMART_BASE_URL/healthz`).

---

## FAQ

### Hermes still displays the original model. Did routing fail?

Not necessarily. The Hermes UI shows the configured model string, not the
model the gateway actually called.

Trust TokSuan's:

- `X-Tokensmart-Landed-Model` response header
- response body `model`
- request row in the dashboard
- Latest savings receipt

### Does prompt caching still work behind TokSuan?

Yes. For Anthropic models, TokSuan auto-injects `cache_control: {type:
"ephemeral"}` markers, which is exactly what Hermes' own
`agent/prompt_caching.py` expects. You typically see 30-60% input-token
savings on long Hermes sessions for free.

For non-Anthropic models, prompt caching is provider-side and pass-through
— TokSuan doesn't touch it.

### What about Anthropic's native Messages API?

Hermes has an `anthropic_messages` API mode that talks to Anthropic's native
endpoint (`/v1/messages`) instead of the OpenAI-compatible shape. TokSuan
currently routes the **OpenAI-compatible** path; if you want native
`anthropic_messages` you can keep that provider direct and only point the
`chat_completions` provider at TokSuan. Hermes' `custom_providers:`
list lets you do this — see the example YAML.

### What if Hermes' plugin hook surface changed?

Plugin APIs evolve. The plugin file in this directory is a starter; if
your Hermes build's `register(ctx)` signature differs, see
`hermes_cli/plugins.py` in your checkout for the canonical surface. Even
without the plugin, the static `x-ts-agent: hermes` header is enough for
project-level attribution.

### Does this work with `hermes --tui` and the dashboard's embedded chat?

Yes. Both the TUI and the embedded dashboard chat use the same `AIAgent`
class and respect the same `~/.hermes/config.yaml`. One config change,
every Hermes surface routes through TokSuan.

---

## Short version

1. Add your provider key in TokSuan Settings.
2. Create a `hermes-personal` project. Copy the `ts_...` API key.
3. `hermes config set model.provider custom`
4. `hermes config set model.base_url <TokSuan /v1 URL>`
5. `hermes config set model.key_env TOKENSMART_API_KEY`
6. `echo 'TOKENSMART_API_KEY=ts_...' >> ~/.hermes/.env`
7. Run one Hermes turn.
8. Check the TokSuan dashboard receipt.

That is the whole integration.
