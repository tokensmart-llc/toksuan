# Example: Cursor IDE through TokSuan

Cursor doesn't have a config file you can `git clone` — its setup is in the
GUI. This example is a step-by-step walkthrough + sanity-check curl + the
exact routing rule we recommend setting on the TokSuan side.

## What this gives you

- **Hard daily cap** on Cursor spend (no more $200 surprise weeks)
- **Auto-routing**: `gpt-4o` autocomplete prompts get downgraded to `gpt-4o-mini`
  for free, while complex Composer requests stay on `gpt-4o`
- **Project-level attribution**: put Cursor in its own TokSuan project so
  the dashboard breaks out Cursor spend cleanly
- **Loop protection**: an unhealthy Cursor session won't drain $50

## Setup (90 seconds)

### 1. Mint a TokSuan key

In the TokSuan dashboard:

1. **Projects → New project** → name it `cursor-personal`
2. **Create API key** → copy the `ts_...` key (shown ONCE)

### 2. Configure Cursor

Open Cursor → **Settings** (⌘,) → **Models**:

| Field | Value |
|---|---|
| Override OpenAI Base URL | `https://gateway.tokensmt.com/v1` (hosted) or `http://localhost:8787/v1` (self-host) |
| OpenAI API Key | `ts_your_project_key_here` |
| Verify | click |
| Model | `gpt-4o-mini` (or `gpt-4o`, `claude-3-5-sonnet-latest`, etc.) |

> ⚠️ **Cursor's embeddings (codebase indexing) bypass this** — they hit OpenAI
> directly. Only chat completions route through TokSuan.

### 3. Sanity check from the command line

```bash
curl https://gateway.tokensmt.com/v1/chat/completions \
  -H "Authorization: Bearer ts_your_project_key_here" \
  -H "Content-Type: application/json" \
  -H "x-ts-tag: tool=cursor,test=sanity-check" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "say hi in 5 words"}]
  }'
```

Open the TokSuan dashboard. You should see this request in **Latest savings
receipt** and **Recent requests** with the `tool=cursor` tag.

### 4. Set a budget on the Cursor project

In `/projects/[id]` for your `cursor-personal` project → **Budgets** card:

- **Daily**: $5/day (≈ 1.5M gpt-4o-mini tokens — generous)
- **Monthly**: $100/month (hard ceiling)

### 5. Set a routing rule for Cursor's autocomplete

In the same project → **Routing rules** card:

```
From pattern:  ^gpt-4o$
To model:      gpt-4o-mini
Threshold:     0.4    (anything below complexity 0.4 gets downgraded)
Mode:          route
```

This downgrades trivial autocomplete prompts to `gpt-4o-mini` (10× cheaper),
while complex Composer requests stay on `gpt-4o`.

## What you'll see in the dashboard after a week

- **Latest savings receipt**: asked model, landed model, actual cost, and saved cost
- **Project-level spend**: the `cursor-personal` project isolates Cursor's usage
- **Top repeating patterns**: if Cursor's getting stuck in a Composer retry
  loop, you'll see the fingerprint here
- **Routed · 24h** stat: count of `gpt-4o → gpt-4o-mini` downgrades. This is
  pure savings.
- **Saved · 30d** hero: dollar value of those downgrades

Cursor's Settings UI does not expose custom request headers. The sanity-check
curl can send `x-ts-tag`, but Cursor's own chat/composer requests generally
cannot. Use a dedicated TokSuan project for attribution.

## CLI alternative — set the rule from the command line

If you'd rather drive the configuration from your dotfiles repo:

```bash
cd apps/gateway

# Set the budget
bun run set-budget -- --period daily --micro-cents 500000

# Set the routing rule
bun run set-routing -- \
  --from "^gpt-4o$" \
  --to "gpt-4o-mini" \
  --threshold 0.4

# Set a Slack alert if Cursor blows the daily budget
bun run set-alert -- \
  --event budget_exceeded \
  --webhook "https://hooks.slack.com/services/..."
```

Every CLI action also writes an audit row, so `/audit` shows the full trail.
