# Cursor → TokSuan

[Cursor](https://cursor.com) supports custom OpenAI-compatible endpoints. Routing Cursor through
TokSuan lets you cap your monthly Cursor model spend and pay only the upstream LLM cost
(when using your own keys), all while keeping Cursor's UI.

## When to do this

- You're hitting Cursor's monthly token limit and want to BYO upstream credits
- You want to **cap your Cursor spend at $X/day** with a hard budget
- You want auto-routing — `gpt-5.2`-tier requests for trivial autocompletes get routed to a cheaper model
- You want per-project / per-day visibility into Cursor's actual model usage

## Configure Cursor

1. Open **Cursor Settings** (⌘ ,)
2. Navigate to **Models**
3. Toggle **Override OpenAI Base URL** ON
4. Set:
   - **OpenAI API Key**: `ts_your_project_key_here` (mint in TokSuan dashboard)
   - **OpenAI Base URL**: `http://localhost:8787/v1` (or `https://gateway.tokensmt.com/v1` for hosted)
5. Click **Verify**
6. Pick a model name TokSuan can route — `gpt-4o`, `gpt-4o-mini`, `claude-3-5-sonnet-latest`, etc.

> **Tip**: Use a TokSuan key tied to a project named `cursor-personal` so you can budget Cursor separately from your other agent traffic.

## Set a budget for Cursor

In the TokSuan dashboard:

1. Open the project you tied the Cursor key to
2. Click **Budgets → Add budget**
3. Pick **$5/day** (or whatever)

Now if Cursor's autocompletes burn through your daily cap, the gateway returns `429
budget_exceeded` and Cursor fails gracefully with the budget message in the UI. You'll see
a clear cost spike before it becomes a $200 surprise.

## Route Cursor's expensive calls to cheaper models

In the project page → **Routing rules**:

```
From: ^gpt-4o$
To:   gpt-4o-mini
Mode: route
Threshold: 0.4    (anything below complexity 0.4 gets downgraded)
```

Now Cursor's autocompletes — short prompts like "complete this function" — use `gpt-4o-mini`
while complex refactors stay on `gpt-4o`.

## Tag Cursor traffic for cost attribution

Cursor doesn't expose custom headers in its UI. Instead, **tag at the project level**: create
a project specifically for Cursor and the dashboard's "Spend by project" card shows you the
breakdown without per-request tagging.

## TokSuan prompt templates + Cursor — limitation

Cursor doesn't let you add custom request headers to its Chat / Composer
calls, and runtime templates are referenced via the `x-ts-template`
header. That means the **dashboard-managed prompt template registry
(`/projects/[id]/templates`) is not directly reachable from Cursor.**

If you want versioned / centrally-managed system prompts for Cursor
work, two paths:

1. Use Cursor's own "Rules for AI" (global or per-workspace) — it's the
   Cursor-native place for this, and it doesn't conflict with TokSuan.
2. Build your prompt tooling outside Cursor (a script using the OpenAI
   SDK or LangChain pointed at TokSuan) where `x-ts-template` is
   fully supported — see
   [`docs/integrations/openai-sdk.md`](./openai-sdk.md) and
   [`docs/integrations/langchain.md`](./langchain.md).

Cursor requests still show up in the dashboard with full cost + routing
telemetry — you just won't see the `template=` tag on them.

## Caveats

- Cursor's "Composer" mode generates large multi-turn requests; expect higher per-call cost
- Cursor's embedding calls (for codebase indexing) hit OpenAI directly — TokSuan only proxies chat completions
- If Cursor reports "OpenAI is degraded" but your gateway is up, check the request log in `/audit` for `502` rows
