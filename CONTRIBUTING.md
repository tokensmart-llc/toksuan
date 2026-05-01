# Contributing to TokSuan

Thanks for your interest. This document describes how to set up a dev environment, the
contribution flow, and what kind of changes we're looking for.

---

## TL;DR

```bash
git clone https://github.com/tokensmart-llc/toksuan.git
cd toksuan
docker compose up -d                              # Postgres
cd apps/gateway && bun install && bun test        # gateway suite should pass
cd ../dashboard && bun install && bun run typecheck
```

If both pass, you have a working dev environment.

---

## Prerequisites

- **Bun** ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`) — no Node, no pnpm, no Python
- **Docker** + Docker Compose
- **Git**

---

## Dev workflow

```bash
# 1. Postgres
docker compose up -d
# pgweb at http://localhost:8081 if you want a DB explorer

# 2. Gateway env
cp apps/gateway/.env.example apps/gateway/.env
# Set at least one provider: OPENAI_API_KEY=sk-... (or any other supported provider)

# 3. Gateway in dev mode (hot reload)
cd apps/gateway
bun install
bun run dev    # → http://localhost:8787

# 4. Dashboard in another terminal
cd ../dashboard
bun install
bun run dev    # → http://localhost:3000
```

In single-tenant mode (no `TOKENSMART_AUTH_ENABLED=1` in dashboard env), the dashboard
is at `http://localhost:3000/dashboard` and shows all projects without a login.
The root path is the public marketing homepage. Useful for fast iteration.

---

## Tests

```bash
cd apps/gateway
bun test
# current gateway suite: 361 tests in the v0.6.7 snapshot
```

LocalStack integration tests for AWS KMS:

```bash
docker compose -f docker-compose.test.yml up -d localstack
./scripts/test-setup-localstack.sh   # creates a CMK, writes .localstack-kms.env
source apps/gateway/.localstack-kms.env
cd apps/gateway && bun test          # +4 integration tests now run
docker compose -f docker-compose.test.yml down
```

Dashboard typecheck:

```bash
cd apps/dashboard && bun run typecheck
# Should complete with no TS errors
```

---

## What we're looking for

In rough priority order:

### 🟢 Highly welcome

- **Integration guides** for tools we don't have yet (Aider, Goose, OpenHands, n8n, Activepieces, Make, Zapier, etc.) — see `docs/integrations/` for the format
- **Provider adapters** for new LLM providers (Mistral direct, Cohere, Together AI, Groq, etc.)
- **Bug fixes** with a clear reproducer
- **Tests** — especially for the policy engine, router, and KMS providers
- **Performance improvements** with benchmarks
- **Security disclosures** — see [`SECURITY.md`](SECURITY.md). Use GitHub private vulnerability reporting; do not open a public issue.

### 🟡 Discuss first via issue

- New core features (semantic cache, prompt versioning, eval pipeline, OTel exporter)
- Breaking changes to the API or DB schema
- New dependencies (each one is a supply-chain surface — we're conservative)
- Major refactors that touch >5 files

### 🔴 Will likely be declined

- Renames or stylistic refactors that don't add functionality
- Adding configuration knobs without a clear use case ("future flexibility" is not a use case)
- New observability backends without a real customer asking
- Anything that introduces a runtime dependency on a paid third-party service for self-hosters

### Out of scope

- **Crypto / blockchain features** — TokSuan's "Token" means LLM tokens. Nothing on-chain. Ever.
- **Spread on tokens** — we charge a flat SaaS fee, never a markup on tokens. PRs that add token-spread billing will be closed.

---

## Contribution flow

1. **Open an issue first** for non-trivial changes. A 5-minute conversation saves a 2-day rewrite.
2. **Fork + branch off `main`**. Branch name: `feat/your-feature` or `fix/issue-123`.
3. **Run tests + build** before pushing.
4. **Write a tight commit message**:
   - One-line summary in imperative mood ("add Mistral provider", not "added")
   - Blank line
   - Body explaining *why*, not *what* (the diff shows the what)
5. **Open a PR**. Reference the issue. Include before/after if it's a UI change.
6. **Be patient** — TokSuan is a small team and reviews can take a few days.

---

## Code style

We don't have a long style guide. Follow the existing code in the file you're editing.
Specifically:

- **TypeScript everywhere** — no plain JS
- **No emoji in code, no emoji in UI**
- **No gradients in UI** except the one accent wash on the featured stat tile
- **Comments explain intent, not what** — if the code says `i++`, don't write `// increment i`
- **Errors are surfaced loudly** — don't swallow exceptions in code paths users hit
- **Sub-cent precision is sacred** — never round costs to whole cents in storage; use `micro_cents` (1¢ = 1000 μ¢)

---

## Architecture overview

| Layer | Tech | Lives in |
|---|---|---|
| Gateway | Bun + Hono + TypeScript | `apps/gateway/` |
| Dashboard | Next.js 15 (App Router) + Bun | `apps/dashboard/` |
| Database | Postgres | `migrations/*.sql` |
| Encryption | AES-256-GCM + envelope (AWS / GCP KMS) | `apps/gateway/src/{crypto,kms-provider,gcp-kms-provider}.ts` |
| Routing policy | Heuristic + benchmark-derived Pareto | `apps/gateway/src/{router,policy/}` |
| Tests | Bun's built-in test runner | `apps/gateway/test/` |

For the product overview, start with [`README.md`](README.md). For production
operations, see [`docs/production-runbook.md`](docs/production-runbook.md).

---

## DB schema changes

Add a new migration file in `migrations/`. **Never edit existing migrations** — they may
already be applied to running deployments.

```bash
# Migrations run lexicographically. Pick the next number.
touch migrations/007_my_change.sql
```

Migrations should be **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN
IF NOT EXISTS`). They get applied automatically on first boot of a fresh DB; existing DBs
need manual application by the operator.

---

## License of contributions

By contributing, you agree your code is released under the same [Apache-2.0
license](LICENSE) as the rest of the repository. By submitting a pull request you grant the
patent license described in §3 of the License.

---

## Questions

- General: open a GitHub issue
- Bug: open a GitHub Issue with a reproducer
- Security: GitHub private vulnerability reporting
