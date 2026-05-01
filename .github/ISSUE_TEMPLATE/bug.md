---
name: Bug report
about: Something is broken — help us reproduce and fix it
title: "[bug] "
labels: ["bug"]
assignees: []
---

## What happened

<!-- Describe what you saw. One paragraph is fine. -->

## What you expected

<!-- Describe what should have happened. -->

## How to reproduce

<!-- The shorter the repro, the faster we fix it. A failing curl is gold. -->

```bash
# example
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer ts_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Environment

- TokSuan version / commit SHA: <!-- e.g. v0.1.0 or 8e4f2c1 -->
- Deployment: [ ] hosted (tokensmt.com)  [ ] self-hosted dev  [ ] self-hosted prod
- OS: <!-- e.g. macOS 15, Ubuntu 24.04 -->
- Bun version (if self-hosted): <!-- bun --version -->
- Postgres version (if self-hosted): <!-- 16.x -->
- Upstream provider(s) involved: <!-- openai, anthropic, ... -->

## Logs

<!-- Gateway log lines, browser console, request detail page screenshot — anything. -->

```
(paste here)
```

## Anything else

<!-- Workarounds you tried, hypotheses about the cause, related issues. -->
