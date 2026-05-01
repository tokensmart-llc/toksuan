# Self-host: nightly per-project policy retraining

> **TL;DR.** TokSuan Cloud retrains every paid customer's routing
> policy each night automatically. Self-hosters get the same code, but
> have to wire their own cron. This page tells you how.

## Why you'd want this

The shipped `apps/gateway/src/policy/baseline-policy.json` artifact
comes from public benchmarks (policy code eval, policy chat eval, etc.). It's a fine
cold-start prior, but it doesn't know anything about *your* prompt mix.
Two installs on the same hardware can have wildly different
(task_type × complexity) distributions, and the cheapest model for
"chat/medium" on benchmark prompts may not be the cheapest for *your*
chat/medium prompts.

The retrain pipeline solves that by:

1. Reading `ab_results` rows for each project (the table the shadow A/B
   path writes to).
2. Bayesian-merging what it observed with the shipped baseline (prior
   weight ≈ 20 samples — see `aggregator.ts`).
3. Writing a fresh `project_policies` row, atomically promoting it to
   `status = 'active'`, and demoting the previous active row to
   `superseded`.

The gateway hot path picks the latest `status='active'` row per project
on each request (cached for 60 s per process). Misses fall back to the
shipped baseline, so this whole pipeline is opt-in and never breaks
existing behavior.

## Prerequisites

- Apply migration 019 (`migrations/019_project_policies.sql`). The
  in-app migration runner does this automatically on the next gateway
  boot.
- You must be running the Postgres backend. The SQLite single-binary
  trial mode (`DATABASE_URL=sqlite:...`) skips the project_policies
  table entirely — the loader serves the shipped baseline for every
  request.
- Make sure the projects you want to train have **shadow A/B writes**
  happening. If `ab_results` is empty you have nothing to learn from.
  See `apps/gateway/src/shadow.ts` for how rows land there (semantic
  routing rules with `mode: shadow|both` and the per-request shadow
  invocation).
- Optional but strongly recommended: configure
  `TOKENSMART_QUALITY_EMBED_MODEL` so each shadow row carries a
  `similarity` score. Without it the aggregator can only update *cost*
  numbers — quality stays anchored to the prior. You'll still get
  cost-aware routing, but a model that's much cheaper AND much worse
  on your prompts will look fine on paper.

## Run it once, manually

```bash
# Aggregate + print summary, but don't write
bun run retrain-project -- --project <project-uuid> --dry-run

# Actually retrain + activate
bun run retrain-project -- --project <project-uuid>

# Override defaults (7-day lookback, prior strength 20)
bun run retrain-project -- --project <project-uuid> --lookback-days 14 --prior 30
```

Successful output looks like:

```
[retrain] project=00000000-0000-0000-0000-000000000001
[retrain]   samples_considered=247 bucket_changes=2
[retrain]   • chat/medium: gpt-5.2 → gemini-2.5-flash-lite after 89 observations
[retrain]   • code/medium: gemini-2.5-flash-lite → qwen3-next after 47 observations
[retrain]   promoted v3 (status=active)

[retrain] done: 1 ok, 0 skipped, 0 failed.
```

## Cron it

### Linux / WSL — systemd timer

`/etc/systemd/system/toksuan-retrain.service`:

```ini
[Unit]
Description=TokSuan nightly per-project policy retrain
After=network.target

[Service]
Type=oneshot
User=toksuan
WorkingDirectory=/opt/toksuan/apps/gateway
EnvironmentFile=/opt/toksuan/apps/gateway/.env
ExecStart=/usr/local/bin/bun run retrain-project -- --all-enabled
StandardOutput=append:/var/log/toksuan-retrain.log
StandardError=append:/var/log/toksuan-retrain.log
```

`/etc/systemd/system/toksuan-retrain.timer`:

```ini
[Unit]
Description=Run TokSuan retrain nightly at 02:30 UTC

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now toksuan-retrain.timer
```

### macOS — launchd

`~/Library/LaunchAgents/ai.toksuan.retrain.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.toksuan.retrain</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>retrain-project</string>
    <string>--</string>
    <string>--all-enabled</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/TokSuan/apps/gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATABASE_URL</key><string>postgres://…</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/toksuan-retrain.log</string>
  <key>StandardErrorPath</key><string>/tmp/toksuan-retrain.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/ai.toksuan.retrain.plist
```

### Anywhere — plain crontab

```cron
30 2 * * *  cd /opt/toksuan/apps/gateway && bun run retrain-project -- --all-enabled >> /var/log/toksuan-retrain.log 2>&1
```

## Per-project opt-in

Only projects with `learning_enabled = TRUE` are picked up by
`--all-enabled`. Flip the flag on a project with:

```sql
UPDATE projects SET learning_enabled = TRUE WHERE id = '<uuid>';
```

This is the same gate TokSuan Cloud uses to scope the cron to paid
tenants. Self-hosters can flip it on for any project they like.

## What gets logged where

- **stdout/stderr from the CLI** — one line per project, plus a per-bucket
  diff line for any bucket where the winner changed. Pipe to a logfile
  per the cron snippets above.
- **`project_policies` rows** — the full retrain history. Read from the
  dashboard at `/projects/<id>/policy`, or query directly:

  ```sql
  SELECT version, status, sample_count, generated_at, notes
  FROM project_policies
  WHERE project_id = '<uuid>'
  ORDER BY version DESC LIMIT 20;
  ```

## Failure modes & rollback

The retrain transaction is atomic — if anything fails (bad SQL, sanity
check refusal, missing baseline artifact), the previous `active` row
stays in place and the gateway keeps routing exactly as it did before.

If a successful retrain regresses real-world savings (you'll see it on
the dashboard's savings card), roll back manually:

```sql
BEGIN;
UPDATE project_policies SET status = 'superseded'
  WHERE project_id = '<uuid>' AND status = 'active';
UPDATE project_policies SET status = 'active', activated_at = NOW()
  WHERE project_id = '<uuid>' AND version = <previous-version>;
COMMIT;
```

Then either restart the gateway processes or wait 60s for the
in-process loader cache TTL to expire.

## Cost transparency

The retrain itself is cheap — it's just SQL aggregation. The expensive
part is whatever judge LLM calls were made *upstream* in the shadow
pipeline (writing `ab_results` rows). Self-host, those calls go on
*your* upstream provider key — you pay for them. Cloud users on a paid
plan have judge calls covered by the subscription.

If you want to estimate what a learning-enabled project costs, the
shadow rows already record `shadow_cost_micro_cents`:

```sql
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*) AS shadow_calls,
  SUM(shadow_cost_micro_cents) / 100000.0 AS shadow_usd
FROM ab_results
WHERE project_id = '<uuid>' AND created_at > NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1 DESC;
```

That's the line item the cloud dashboard's "learning cost this month"
card shows in v0.6+.
