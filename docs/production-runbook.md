# Production Runbook

This is the deployment checklist for teams running TokSuan in production.
It turns the security and state docs into operator decisions.

## 1. Pick The Ownership Model

- **Hosted `tokensmt.com`**: TokSuan owns gateway/dashboard uptime, KMS,
  Stripe, scheduled jobs, and provider/pricing maintenance. There is no formal
  SLA yet; if procurement requires one today, self-host or discuss Enterprise.
- **Self-host**: you own infra, SLOs, backups, retention, edge protection, and
  incident response. The Apache-2.0 code is the same product.

## 2. Migrations

For a single VM or Docker Compose deployment, letting the gateway run migrations
on boot is acceptable.

For multi-replica deployments:

1. Run migrations from one dedicated job before rolling out gateway pods.
2. Set `TOKENSMART_AUTO_MIGRATE=0` on normal gateway replicas.
3. Mount `migrations/` read-only into the migration job and gateway image.
4. Treat migration failure as a deploy blocker.

Do not let every replica race to apply migrations during a rolling deploy.

## 3. Edge Protection

Do not expose the gateway directly to the public internet without an edge layer.
Put one of these in front:

- Cloudflare / AWS ALB / API Gateway / Nginx with rate limiting
- TLS termination
- request-size limits
- basic DDoS protection

Set `TOKENSMART_CORS_ALLOW_ORIGINS` to a concrete allowlist in production.
Avoid `*` unless this is a private single-tenant gateway behind another auth
boundary.

## 4. Secrets

Required production secrets:

- `DATABASE_URL`
- at least one provider key OR the BYO-provider-key flow
- `TOKENSMART_PROVIDER_KEY_ENCRYPTION` or KMS config
- `TOKENSMART_INTERNAL_REPLAY_ENABLED=1` plus `TOKENSMART_INTERNAL_TOKEN` if
  dashboard replay is enabled
- `RESEND_API_KEY` / `RESEND_FROM` for hosted auth
- Stripe keys if billing is enabled

Hosted posture should prefer BYO provider keys over operator-paid fallback
keys. TokSuan does not take a token spread; customers keep their provider
relationship and provider bill.

Single-tenant auth-off mode prints a bootstrap API key once to gateway logs.
Treat that log line as a password:

- restrict `docker logs` / log aggregator access
- rotate the key after first setup
- avoid shipping first-boot logs to broad shared channels

## 5. BYO Key Encryption

Recommended production posture:

- Hosted / AWS: `TOKENSMART_KMS_KEY_ARN`
- GCP self-host: `TOKENSMART_GCP_KMS_KEY_NAME`
- Single-tenant private deploy: env master key is acceptable, but document who
  can read the env and how rotation works.

Run key-rotation and env-to-KMS migration scripts during low-traffic windows.

## 6. Request Body Storage

Set `TOKENSMART_STORE_FULL_REQUEST_BODY` deliberately:

- `sample` (default): full bodies for failures + small success sample
- `never`: privacy-sensitive workloads; prompts are not retained in the ledger
- `always`: debugging-heavy deployments with explicit retention controls

Align this with your DPA, customer promises, and Postgres retention policy.

## 7. Data Retention And Backups

Minimum production checklist:

- Postgres automated backups / PITR
- backup restore test before public launch
- `TOKENSMART_REQUEST_RETENTION_DAYS` set for hosted-style rolling deletion
- scheduled `sweep-old-requests`
- deletion process for a single project / user
- audit log retention policy

Self-host defaults keep data forever unless you schedule cleanup.

## 8. Dashboard Scaling

The dashboard works as a single Next.js process. For multiple replicas:

- keep session cookies on the same domain
- use a shared database
- be aware some auth throttles are in-process today
- put an edge rate limit in front of `/login` and auth routes

Promote rate limiting to Redis or DB-backed counters before high-volume hosted
multi-replica deployment.

## 9. Observability

Recommended:

- set `OTEL_EXPORTER_OTLP_ENDPOINT`
- centralize gateway and dashboard logs
- alert on gateway `/health` failures
- alert on plan/budget blocks if they exceed expected thresholds
- track rewrite-fallback rate; high rates indicate stale policy artifacts

Streaming success responses cannot include final cost headers because headers
flush before token usage is known. Use `X-Tokensmart-Request-Id` and the request
row for streaming cost proof.

## 10. Routing Quality Rollout

Before expanding automatic route-down:

1. Start with baseline policy.
2. Add a low-sample shadow rule for important workloads.
3. Enable `TOKENSMART_QUALITY_EMBED_MODEL` if you need semantic quality proof.
4. Watch `/routing-quality` for success-rate drops.
5. Promote only routes with sufficient samples and acceptable quality.

Use the dashboard receipt as cost proof and shadow A/B as quality proof.

Complexity judging defaults to `TOKENSMART_CLASSIFIER_MODE=byo_same_provider`:
the gateway chooses a cheap judge model from the same provider family as the
caller-requested model and resolves it through the user's BYO key. If no
matching BYO key exists, it uses the local heuristic and does not spend the
operator's platform key or send prompts to a different provider. Use
`TOKENSMART_CLASSIFIER_MODE=explicit` only for self-host/demo deployments where
the operator intentionally pays for one shared judge model.

## 11. Self-Hosted Model Cost Semantics

For paid API providers, TokSuan can compute dollar savings from token
pricing.

For self-hosted / custom endpoints, TokSuan does not know your real GPU cost
by default. Treat the default receipt as routing/capacity proof:

- large-model endpoint avoided
- smaller / cheaper pool used
- queue pressure reduced
- budget guard still applied via conservative reservation

Only show exact dollar savings for self-hosted endpoints after you define the
endpoint's price or pool cost model. Until then, phrase the value as "capacity
freed" or "large-model usage avoided", not precise net dollar savings.

## 12. Upgrade Checklist

Before pulling a new version:

- read `CHANGELOG.md`
- check for new migrations
- check for classifier artifact schema bumps
- run `bun test` in `apps/gateway`
- run `bun run typecheck` in `apps/dashboard`
- deploy to staging and send one real request
- confirm `/health`, `/trust`, `/dashboard` receipt, and `/routing-quality`

Embedding classifier users must retrain if the artifact schema version changes.
