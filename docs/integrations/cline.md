# Cline → TokSuan

[Cline](https://github.com/cline/cline) is an autonomous VS Code coding agent. It's also the
single workload most likely to discover TokSuan's loop detector by accident — a misbehaving
Cline session can repeatedly emit the same tool call until you go bankrupt or notice.

## Configure Cline

1. Open the Cline panel in VS Code
2. Click the ⚙️ settings icon
3. **API Provider**: select **OpenAI Compatible**
4. **Base URL**: `http://localhost:8787/v1` (self-hosted) or `https://gateway.tokensmt.com/v1` (hosted)
5. **API Key**: `ts_your_project_key_here` (mint in TokSuan dashboard)
6. **Model ID**: any model TokSuan routes — `claude-3-5-sonnet-latest`, `gpt-4o`, `deepseek-coder`, etc.

Click **Done**. Cline will now route every chat completion through TokSuan.

## Why this is high-value for Cline specifically

Cline is **agentic** — it loops on the same goal, applies tools, observes, retries. The four
biggest Cline failure modes are exactly what TokSuan catches:

| Failure mode | TokSuan's defense |
|---|---|
| Cline stuck in a "read file → propose change → apply → read file again" loop | **Loop detector** — fires on the 11th identical fingerprint, returns 429 |
| Cline accidentally uses `claude-opus` for a trivial task | **Routing rule** — auto-downgrade to `claude-haiku` for low-complexity prompts |
| Cline session burns $50 in 30 minutes | **Budget** — hard cap at $X/day, returns 429 |
| Cline fails silently with a wrong model output | **Audit log** — every request inspectable, full `request_body` + `response_body` |

## Recommended budget for Cline

Cline routinely emits 50–200k token contexts. Set a generous-but-finite budget:

- Personal use: **$5/day** (≈ 1.5M Sonnet tokens)
- Heavy production use: **$20/day**

Even the "expensive" cap saves you from waking up to $500 because Cline got stuck in a fix-build
loop on a file with a syntax error.

## Anthropic auto cache_control

If you point Cline at `claude-3-5-sonnet-latest` or any `claude-*` model, TokSuan automatically
stamps `cache_control: ephemeral` on the system block, the last tool definition, and the
second-most-recent user message. Cline sends giant system prompts (its toolset is huge), so
this typically saves **30–60% on long-running sessions** — without any configuration.

You'll see this on each request page: the "Cached tokens" stat shows how much was hit on cache.

## Tag Cline traffic

Cline doesn't expose custom headers in its UI. Tag at the project level — create a project
called `cline-coding` and the dashboard's Project filter does the attribution.

## TokSuan prompt templates + Cline — limitation

TokSuan's runtime prompt-template registry (`/projects/[id]/templates`)
is referenced via the `x-ts-template` request header. Cline's API-provider
config doesn't let you attach custom headers to chat completions, so
there's no way to point Cline at a dashboard-managed template version
from inside the Cline settings UI.

This is less of a loss than it sounds: Cline ships its own (very large,
carefully tuned) system prompts, and you generally don't want to override
those. The template registry is designed for smaller, domain-specific
agents and chat apps — not for replacing Cline's coding harness.

If you have a **secondary** workload (e.g. a custom review pipeline
that calls an LLM outside Cline), that one can use `x-ts-template` via
any of the SDK-based guides — see
[`docs/integrations/openai-sdk.md`](./openai-sdk.md),
[`docs/integrations/vercel-ai-sdk.md`](./vercel-ai-sdk.md),
[`docs/integrations/langchain.md`](./langchain.md).

Cline's own requests still land in the dashboard with full cost /
routing / loop-detection telemetry — they just won't carry a `template=`
tag.

## Common Cline errors and what they mean

| Cline error | TokSuan cause | Fix |
|---|---|---|
| `Loop detected — Likely agent loop: identical request repeated 10 times in the last 5 minutes.` | Cline got stuck on the same fingerprint. **Working as intended.** | Investigate why Cline is stuck. Cancel the task, fix the underlying file/state. |
| `Budget exceeded for the daily period. Limit $5.0000, already spent $5.0001.` | Hit your daily cap. | Bump the budget in `/projects/[id]` if you want to keep going today. |
| `Plan limit reached on the Free tier.` | Hit your hosted-tier 24h cap (Free = $1/24h). | Upgrade to Pro. Self-host removes this limit entirely. |
| `Upstream provider request failed: 429 rate limit` | Anthropic / OpenAI rate-limited you. | TokSuan auto-retries up to 2 times. If still failing, slow Cline down via VS Code setting. |

## Verifying it's working

After running Cline for a few minutes:

1. Open `http://localhost:3000`
2. Look at "Recent requests" — every Cline call should be there with timestamps and costs
3. Check "Cached tokens" stat for `claude-*` models — should be > 0 if Cline is using a long stable system prompt
4. Click any request → see the full `request_body` JSON Cline sent
