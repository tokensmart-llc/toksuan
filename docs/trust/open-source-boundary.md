# Open-Source Boundary

TokSuan is open-source where trust matters: the gateway, dashboard, request
ledger, budget enforcement, routing decisions, key handling, and self-host
operations are inspectable and runnable under Apache-2.0.

TokSuan hosted adds managed operation, continuously updated policy
artifacts, privacy-thresholded aggregate telemetry, support, and enterprise
deployment work. Those hosted operations are not the request-path trust
boundary, and they are not fully included in this repository.

## Included In The Open-Source Product

The public repository includes:

- OpenAI-compatible gateway runtime.
- Provider adapters and provider-resolution logic.
- Per-project API keys, hashing, and BYO provider-key encryption.
- Budget enforcement, loop detection, request fingerprinting, failover, alerts,
  tags, semantic cache, and prompt-template substitution.
- Request ledger schema, migrations, and dashboard views.
- Baseline routing runtime: how a request is classified, how the policy is
  consulted, how unreachable providers are skipped, and how receipts are
  recorded.
- The shipped baseline policy artifact (`baseline-policy.json`) with
  public-safe model/cost/quality numbers and abstract provenance
  (`public_agent_eval_mix`).
- Self-host training paths that use **your own local traffic**, such as
  `retrain-project` and `train-embedding-classifier`.
- Self-host deployment docs, Docker assets, integration guides, and trust
  templates.

The goal is that a self-hosted operator can understand and run the control
plane without sending prompts, responses, provider keys, or request logs to
TokSuan.

This request-path boundary is not an action-safety firewall. TokSuan can
make model calls, budgets, routing decisions, and request-path behavior
inspectable; destructive shell commands, database writes, cloud mutations, and
other tool executions still need least-privilege infrastructure controls. See
[`agent-action-boundary.md`](agent-action-boundary.md).

## Not Included In The Public Repository

The public repository intentionally does not include:

- The hosted baseline-policy generation harness and benchmark runners.
- Benchmark datasets, benchmark run logs, model-roster experiments, or
  eval-specific extraction recipes.
- Cross-customer routing-intelligence pipelines.
- Hosted aggregate telemetry processing beyond the public collector schema and
  opt-in self-host sender.
- Private provider-pricing negotiations or hosted policy promotion playbooks.
- Abuse/fraud controls and internal ops runbooks.
- Private deployment infrastructure, secrets, or internal strategy docs.

These are hosted operations rather than self-host request-path requirements.
They may influence future policy artifacts, but the runtime behavior of each
artifact remains inspectable in the public gateway.

## Baseline Policy Vs Policy Generation

`apps/gateway/src/policy/baseline-policy.json` is public because it is used by
the gateway at runtime. Operators can inspect the buckets, model entries,
costs, quality scores, sample counts, and routing frontier.

The process that generates the hosted baseline artifact is not public. Public
metadata intentionally uses an abstract provenance label:

```json
"benchmarks": ["public_agent_eval_mix"]
```

This avoids turning the open-source runtime into a debate over TokSuan's
current hosted evaluation recipe while still leaving the actual policy numbers
visible.

## Local Retraining

Self-hosted installs can train from their own data:

- `bun run retrain-project` reads local shadow A/B observations and produces a
  project-specific routing policy.
- `bun run train-embedding-classifier` trains a lightweight local classifier
  from local `requests` rows and optional shadow-quality signals.

Those scripts do not require TokSuan hosted telemetry. They are included
because they help self-host users adapt the open-source runtime to their own
traffic.

## Telemetry

Self-hosted deployments do not phone home by default.

If an operator chooses to contribute to the public routing map, they can opt in
to anonymous daily aggregates:

```bash
TOKENSMART_ANON_TELEMETRY=1 \
TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID=<random-local-id> \
bun run send-anon-telemetry -- --yesterday
```

The sender never uploads prompts, responses, request bodies, provider keys,
user emails, project names, request IDs, or exact per-request timestamps.

Hosted aggregate telemetry and opt-in self-host aggregates are published only
after privacy thresholds are met.

