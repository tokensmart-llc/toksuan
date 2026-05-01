# Agent Action Boundary

TokSuan is built for long-running, tool-using agents, but it does not claim
to be an action-safety firewall.

A model gateway can enforce model spend because every model request passes
through it. It can keep a request ledger, cap budgets before upstream billing,
detect repeated model loops, and route simple turns to cheaper models. It cannot
guarantee protection for shell commands, database writes, cloud APIs, or tool
executions that happen outside the model request path.

Any product that claims complete destructive-action safety solely from the
model-gateway layer is overpromising. Real action safety needs infrastructure
controls at the execution boundary.

## What TokSuan Is Responsible For

TokSuan is responsible for behavior visibility and cost guardrails:

- Request receipts: asked model, landed model, routing reason, tokens, latency,
  cost, and savings.
- Safe tool-intent metadata when available: declared tool names/counts and
  observed tool-call names/counts, without storing tool arguments in tags.
- Agent/session attribution when callers send `x-ts-agent`, `x-ts-session`,
  `x-ts-turn`, and `x-ts-channel`.
- Budget and plan caps before upstream model billing.
- Loop detection for repeated model-call fingerprints.
- Evidence-based routing and shadow trials so simple work can move to cheaper
  models without hiding the decision.
- Alerts and anomaly signals for spend, loops, failed requests, and other
  request-path events.

In other words, TokSuan helps operators understand what an agent is doing in
the model path and how much it costs. It is the place to see, cap, and optimize
agent model usage.

## What TokSuan Is Not Responsible For

TokSuan does not replace the safety boundary around the tools an agent can
execute. In particular, it does not guarantee that an agent cannot:

- Delete or mutate a production database.
- Run destructive shell commands on the host machine.
- Delete cloud resources or backups.
- Exfiltrate secrets that are already available to the agent process.
- Abuse over-scoped credentials placed in the agent's environment.

Those risks must be controlled where the action happens: database roles, cloud
IAM, sandboxed execution, network egress controls, scoped API tokens, backups,
and reviewable deployment workflows.

## How To Prevent Destructive Agent Actions

Use infrastructure boundaries that make dangerous actions unavailable by
default:

- Give agents read-only database users unless they explicitly need write access.
- Keep production write credentials out of agent workspaces and `.env` files.
- Run shell-capable agents inside disposable containers or sandboxes.
- Use scoped cloud/API credentials instead of owner/admin tokens.
- Keep backups and database point-in-time recovery enabled.
- Prefer staging or branch databases for agent experiments and migrations.
- Use dedicated tool-call guardrails or MCP/tool proxies when you need execution
  enforcement.

TokSuan can make the agent's model usage and request-path behavior visible,
but it cannot substitute for these execution-layer controls.

## Product Stance

TokSuan does not promise "safe autonomous agents" from a gateway alone. That
promise would create a false sense of security.

TokSuan's promise is narrower and stronger:

> Make agent model usage visible. Cap runaway spend. Stop repeated model loops.
> Route simple work to cheaper models when evidence supports it. Keep the
> receipts inspectable.

For action safety, pair TokSuan with least-privilege infrastructure and
sandboxed execution. TokSuan gives you the model-path ledger; your execution
environment remains the action boundary.
