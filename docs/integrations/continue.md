# Continue.dev → TokSuan

[Continue.dev](https://continue.dev) is a VS Code / JetBrains coding assistant. It supports
custom OpenAI-compatible providers via the `~/.continue/config.json` file.

## Configure

Edit `~/.continue/config.json` (or `%USERPROFILE%\.continue\config.json` on Windows):

```jsonc
{
  "models": [
    {
      "title": "TokSuan · gpt-4o",
      "provider": "openai",
      "model": "gpt-4o",
      "apiKey": "ts_your_project_key_here",
      "apiBase": "http://localhost:8787/v1",
      "requestOptions": {
        "headers": {
          "x-ts-tag": "tool=continue,user=alice"
        }
      }
    },
    {
      "title": "TokSuan · claude-3-5-sonnet",
      "provider": "openai",
      "model": "claude-3-5-sonnet-latest",
      "apiKey": "ts_your_project_key_here",
      "apiBase": "http://localhost:8787/v1",
      "requestOptions": {
        "headers": {
          "x-ts-tag": "tool=continue,user=alice"
        }
      }
    }
  ],
  "tabAutocompleteModel": {
    "title": "TokSuan · autocomplete",
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "ts_your_project_key_here",
    "apiBase": "http://localhost:8787/v1",
    "requestOptions": {
      "headers": {
        "x-ts-tag": "tool=continue,feature=autocomplete"
      }
    }
  }
}
```

Save the file. Continue picks up changes without a restart.

## Why this is great for autocomplete specifically

Tab autocomplete in Continue is **the** workload that benefits most from cheap routing. Each
keystroke can fire a completion. With TokSuan:

- **Auto-route to the cheapest model that survives quality** (default baseline policy)
- **Per-feature tag** (`feature=autocomplete` vs `feature=chat`) → see exactly how much
  autocomplete costs you per day in the dashboard
- **Hard daily budget** prevents a runaway autocomplete loop from costing $50

Recommended pairing:

```
tabAutocompleteModel:  gpt-4o-mini    + budget $1/day
chat models:           gpt-4o         + budget $5/day
```

## Use a TokSuan prompt template

Continue's `requestOptions.headers` is the knob: each `models[]` entry can
carry its own `x-ts-template` header, letting one Continue config swap in
a different dashboard-managed system prompt per profile without editing
Continue's own prompts file.

```jsonc
{
  "models": [
    {
      "title": "TokSuan · review-bot",
      "provider": "openai",
      "model": "gpt-4o",
      "apiKey": "ts_your_project_key_here",
      "apiBase": "http://localhost:8787/v1",
      "requestOptions": {
        "headers": {
          "x-ts-template": "code-review@7",
          "x-ts-template-vars": "{\"style\":\"strict\"}"
        }
      }
    }
  ]
}
```

Continue doesn't let you attach extra request-body fields, so larger /
multi-line variables need to stay JSON-encoded in the
`x-ts-template-vars` header. For big templates (e.g. a 2k-token system
prompt with many fill-ins), author the template body in the dashboard
instead of passing variables — that's what the template registry is for.

Each model entry can reference a different template, letting you have
`code-review@7`, `debug-helper@2`, `autocomplete@1` live side-by-side
in one Continue config. Requests auto-tag as `template=<name>` +
`template_version=<N>` so the dashboard's "Spend by tag" card tells you
which template is eating your daily Continue budget.

---

## Verifying it's working

After typing in any open file:

1. Open the TokSuan dashboard at `http://localhost:3000`
2. "Recent requests" shows autocomplete calls landing
3. "Spend by tag" card breaks down `tool=continue feature=autocomplete` vs `tool=continue feature=chat`

## Known limitations

- Continue's embedding provider hits the upstream directly — TokSuan only proxies chat completions
- Continue's "context provider" tools also bypass TokSuan unless they're chat completions
