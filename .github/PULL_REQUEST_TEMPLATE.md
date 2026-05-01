## What this PR does

<!-- One paragraph. The diff shows the "what"; this is the "why". -->

## Issue link

<!-- "Closes #123" or "Refs #45". Open an issue first if non-trivial — see CONTRIBUTING.md. -->

## How to test

<!--
Reviewer-runnable steps. The shorter the better. If your PR includes a curl
or a `bun test` invocation, paste them here.
-->

## Checklist

- [ ] `bun test` (gateway) passes locally
- [ ] `bun run build` (dashboard) succeeds
- [ ] `bun run typecheck` (gateway) is clean
- [ ] If schema changed: added a new migration file in `migrations/` (never edit existing ones)
- [ ] If new env var: documented in `apps/gateway/.env.example` or `apps/dashboard/.env.example`
- [ ] If new feature: noted in `CHANGELOG.md` under Unreleased
- [ ] No emoji added to code or UI (per design discipline)
- [ ] No new runtime dependency (or justified in the PR description)
