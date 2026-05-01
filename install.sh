#!/usr/bin/env bash
# TokenSmart — one-shot self-host installer.
#
# Goal: take a fresh box (macOS or Linux) from "git clone" to a running
# gateway + dashboard in under 5 minutes, with zero "edit this file then
# come back" friction. Fixes the OSS-audit "Condition #2: 5 minutes to run"
# from the public launch checklist.
#
# What it does, in order:
#   1.  Sanity-check prerequisites (git, docker, openssl). Hint how to
#       install Bun if missing — we don't auto-install it because curl-pipe-bash
#       is a security smell on someone else's repo.
#   2.  Boot Postgres + pgweb via the existing docker-compose.yml
#       (skipped in --sqlite mode — gateway runs against an in-process
#       bun:sqlite file with zero dependencies).
#   3.  Write apps/gateway/.env if it doesn't exist (copies .env.example,
#       generates a master encryption key, leaves provider keys to the user).
#   4.  Write apps/dashboard/.env.local if it doesn't exist (mirrors the
#       master key — this is the #1 footgun for new operators).
#   5.  bun install in both apps (no-op if already done).
#   6.  Print the final "you are ready" block with three URLs + a sample curl.
#
# Idempotent. Safe to re-run. Never overwrites an existing .env file —
# prints a diff hint instead.
#
# Usage:
#   ./install.sh                       # default: non-interactive. Leaves provider
#                                      # keys blank in the generated .env so you
#                                      # can `$EDITOR apps/gateway/.env` and paste
#                                      # them (the script does NOT prompt — pipe-
#                                      # to-bash installers and passwords-on-stdin
#                                      # are a security smell we intentionally avoid).
#   ./install.sh --noninteractive      # alias for the default, kept for CI clarity.
#   ./install.sh --skip-deps           # skip `bun install`
#   ./install.sh --sqlite              # single-binary trial mode: skips Docker
#                                      # entirely, gateway uses bun:sqlite.
#                                      # Multi-tenant features (auth, BYO
#                                      # encrypted keys, dashboard SSO) are
#                                      # NOT supported in this mode.
#
# This script does NOT start the gateway or dashboard processes — those are
# meant to live in your terminal so you can read their logs. It tells you
# the exact commands to run at the end.

set -euo pipefail

NONINTERACTIVE=0
SKIP_DEPS=0
SQLITE_MODE=0
for arg in "$@"; do
  case "$arg" in
    --noninteractive) NONINTERACTIVE=1 ;;
    --skip-deps)      SKIP_DEPS=1 ;;
    --sqlite)         SQLITE_MODE=1 ;;
    -h|--help)
      sed -n '2,38p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# ---- ANSI helpers (only when stdout is a TTY) ------------------------------
if [ -t 1 ]; then
  C_BOLD="\033[1m"; C_DIM="\033[2m"; C_OK="\033[32m"; C_WARN="\033[33m"
  C_ERR="\033[31m"; C_ACCENT="\033[36m"; C_RESET="\033[0m"
else
  C_BOLD=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_ACCENT=""; C_RESET=""
fi

step()  { printf "${C_ACCENT}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$1"; }
ok()    { printf "    ${C_OK}✓${C_RESET} %s\n" "$1"; }
warn()  { printf "    ${C_WARN}!${C_RESET} %s\n" "$1"; }
fail()  { printf "    ${C_ERR}✗${C_RESET} %s\n" "$1"; exit 1; }
info()  { printf "    ${C_DIM}%s${C_RESET}\n" "$1"; }

# ---- 1. Prereq check -------------------------------------------------------
step "Checking prerequisites"

need_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 not found. $2"
  fi
  ok "$1"
}

need_bin git     "Install via your package manager (brew install git / apt install git)."
need_bin openssl "Install via your package manager (brew install openssl / apt install openssl)."

if [ "$SQLITE_MODE" -eq 0 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker not found. Install Docker Desktop (macOS/Win) or Docker Engine (Linux): https://docs.docker.com/get-docker/  (or pass --sqlite for the no-Docker trial mode)"
  fi
  ok "docker"

  # Compose v2 ships as `docker compose`. v1 (`docker-compose`) is EOL.
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    ok "docker compose (v2)"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    warn "docker-compose v1 detected — consider upgrading to v2 (Compose plugin)."
  else
    fail "Neither 'docker compose' nor 'docker-compose' is available."
  fi
else
  ok "docker (skipped — --sqlite mode)"
fi

if ! command -v bun >/dev/null 2>&1; then
  warn "bun not found — needed to run gateway + dashboard."
  info "Install: curl -fsSL https://bun.sh/install | bash"
  info "Then re-run this installer (or pass --skip-deps if installing later)."
  if [ "$SKIP_DEPS" -eq 0 ]; then
    fail "Please install bun and re-run, or pass --skip-deps to defer."
  fi
else
  ok "bun ($(bun --version 2>/dev/null || echo "?"))"
fi

# ---- 2. Database ----------------------------------------------------------
if [ "$SQLITE_MODE" -eq 1 ]; then
  step "Provisioning local SQLite file (no Docker)"
  mkdir -p apps/gateway/data
  ok "data dir at apps/gateway/data/"
  info "DB will live at apps/gateway/data/tokensmart.db (auto-created on gateway boot)"
else
  step "Starting Postgres + pgweb (docker compose up -d)"

  # `up -d` is a no-op if already up; we just want to make sure it's running.
  $COMPOSE up -d postgres pgweb >/tmp/tokensmart-compose.log 2>&1 || {
    cat /tmp/tokensmart-compose.log
    fail "docker compose failed — see output above."
  }
  ok "Postgres on :5432 and pgweb on :8081"

  # Wait for Postgres health — at most 30s.
  PG_READY=0
  for _ in $(seq 1 30); do
    if $COMPOSE exec -T postgres pg_isready -U tokensmart -d tokensmart >/dev/null 2>&1; then
      PG_READY=1
      break
    fi
    sleep 1
  done
  if [ "$PG_READY" -eq 1 ]; then
    ok "Postgres accepting connections"
  else
    warn "Postgres didn't respond to pg_isready in 30s — gateway will still try to connect on boot."
  fi
fi

# ---- 3. Generate master encryption key (shared by gateway + dashboard) ----
step "Generating master encryption key"

# We create the key ONCE here and write it to BOTH env files so they match.
# This is the #1 footgun new operators hit (gateway encrypts with key A,
# dashboard tries to decrypt with key B).
MASTER_KEY="$(openssl rand -hex 32)"
ok "32-byte hex key generated (TOKENSMART_PROVIDER_KEY_ENCRYPTION)"

# ---- 4. Write apps/gateway/.env if missing --------------------------------
step "Writing apps/gateway/.env (if missing)"

GW_ENV="apps/gateway/.env"
if [ -f "$GW_ENV" ]; then
  warn "$GW_ENV already exists — leaving it untouched."
  if grep -q "^TOKENSMART_PROVIDER_KEY_ENCRYPTION=" "$GW_ENV"; then
    info "Existing master key preserved. (Make sure dashboard uses the same value.)"
    EXISTING_KEY="$(grep "^TOKENSMART_PROVIDER_KEY_ENCRYPTION=" "$GW_ENV" | head -n1 | cut -d= -f2-)"
    MASTER_KEY="${EXISTING_KEY:-$MASTER_KEY}"
  else
    info "No TOKENSMART_PROVIDER_KEY_ENCRYPTION in existing file — append with the value below if you want BYO."
    info "  echo \"TOKENSMART_PROVIDER_KEY_ENCRYPTION=$MASTER_KEY\" >> $GW_ENV"
  fi
else
  cp apps/gateway/.env.example "$GW_ENV"
  # Append the master key (the example file leaves it commented).
  printf "\n# Generated by install.sh on %s\nTOKENSMART_PROVIDER_KEY_ENCRYPTION=%s\n" \
    "$(date +%Y-%m-%dT%H:%M:%S%z)" "$MASTER_KEY" >> "$GW_ENV"

  # SQLite-mode override: rewrite DATABASE_URL to point at the in-process
  # bun:sqlite file. Postgres-mode leaves the example default in place.
  if [ "$SQLITE_MODE" -eq 1 ]; then
    SQLITE_URL="sqlite:./data/tokensmart.db"
    if grep -q "^DATABASE_URL=" "$GW_ENV"; then
      # Use awk for portable in-place edit (sed -i differs macOS vs GNU).
      awk -v new="DATABASE_URL=$SQLITE_URL" \
        '/^DATABASE_URL=/ { print new; next } { print }' \
        "$GW_ENV" > "$GW_ENV.tmp" && mv "$GW_ENV.tmp" "$GW_ENV"
    else
      printf "\nDATABASE_URL=%s\n" "$SQLITE_URL" >> "$GW_ENV"
    fi
    info "DATABASE_URL set to $SQLITE_URL — gateway will use bun:sqlite"
  fi

  ok "Wrote $GW_ENV (with master encryption key pre-filled)"
  warn "Provider keys NOT set — uncomment + fill in OPENAI_API_KEY (or another) in $GW_ENV before going to prod."
fi

# ---- 5. Write apps/dashboard/.env.local if missing ------------------------
# In SQLite mode the dashboard isn't supported (no users/auth/Stripe schema
# in the trial DB). Skip dashboard env entirely so we don't mislead the
# operator into thinking it'll work.
if [ "$SQLITE_MODE" -eq 1 ]; then
  step "Skipping dashboard env (--sqlite mode is gateway-only)"
  info "Dashboard requires Postgres for auth/Stripe/Org tables; re-run install.sh without --sqlite to enable it."
  DB_ENV=""
else
step "Writing apps/dashboard/.env.local (if missing)"

DB_ENV="apps/dashboard/.env.local"
if [ -f "$DB_ENV" ]; then
  warn "$DB_ENV already exists — leaving it untouched."
  if grep -q "^TOKENSMART_PROVIDER_KEY_ENCRYPTION=" "$DB_ENV"; then
    DB_KEY="$(grep "^TOKENSMART_PROVIDER_KEY_ENCRYPTION=" "$DB_ENV" | head -n1 | cut -d= -f2-)"
    if [ "$DB_KEY" != "$MASTER_KEY" ]; then
      warn "Master key in $DB_ENV does NOT match $GW_ENV — BYO decryption will fail."
      info "Fix manually: both files MUST have identical TOKENSMART_PROVIDER_KEY_ENCRYPTION."
    else
      ok "Master keys match between gateway and dashboard"
    fi
  fi
else
  cp apps/dashboard/.env.example "$DB_ENV"
  printf "\n# Generated by install.sh on %s\nTOKENSMART_PROVIDER_KEY_ENCRYPTION=%s\n" \
    "$(date +%Y-%m-%dT%H:%M:%S%z)" "$MASTER_KEY" >> "$DB_ENV"
  ok "Wrote $DB_ENV (with matching master key)"
fi
fi  # end !SQLITE_MODE block

# ---- 6. Install dependencies ----------------------------------------------
if [ "$SKIP_DEPS" -eq 0 ]; then
  step "Installing dependencies (bun install)"
  ( cd apps/gateway && bun install --silent ) && ok "apps/gateway"
  if [ "$SQLITE_MODE" -eq 0 ]; then
    ( cd apps/dashboard && bun install --silent ) && ok "apps/dashboard"
  else
    info "skipping apps/dashboard install (--sqlite trial mode is gateway-only)"
  fi
else
  step "Skipping bun install (--skip-deps)"
fi

# ---- 7. Print the final ready-to-go block ---------------------------------
echo
printf "${C_OK}${C_BOLD}TokenSmart is ready.${C_RESET}\n\n"

if [ "$SQLITE_MODE" -eq 1 ]; then
cat <<EOF
${C_BOLD}Start the gateway${C_RESET} (no other process needed):
    cd apps/gateway && bun run dev
    # listens on http://localhost:8787
    # auto-applies migrations from migrations-sqlite/
    # data file: apps/gateway/data/tokensmart.db

${C_BOLD}Then smoke-test${C_RESET}:
    curl http://localhost:8787/health
    # => {"ok":true,...,"backend":"sqlite",...}

    curl http://localhost:8787/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer tokensmart-dev-key" \\
      -d '{
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Say hello"}]
      }'
    # NOTE: requires OPENAI_API_KEY (or another provider) in $GW_ENV

${C_BOLD}URLs${C_RESET}:
    Gateway   http://localhost:8787

${C_BOLD}${C_WARN}SQLite trial-mode caveats${C_RESET}:
  • No dashboard, no auth, no Stripe, no organizations / RBAC,
    no BYO encrypted provider keys, no semantic cache, no shadow A/B
    persistence, no cost-anomaly monitor. These are hosted features —
    re-run ./install.sh without --sqlite (Postgres + Docker) to enable.
  • Single-process only — concurrent gateway instances will fight for
    the data file. Bun:sqlite uses WAL but isn't a clustering option.

${C_DIM}Need to add provider credentials?  Edit $GW_ENV and restart the gateway.${C_RESET}
${C_DIM}Need to start over?               rm -rf apps/gateway/data $GW_ENV && ./install.sh --sqlite${C_RESET}
EOF
else
cat <<EOF
${C_BOLD}Start the gateway${C_RESET} (in one terminal):
    cd apps/gateway && bun run dev
    # listens on http://localhost:8787
    # auto-applies migrations on first boot

${C_BOLD}Start the dashboard${C_RESET} (in a second terminal):
    cd apps/dashboard && bun run dev
    # listens on http://localhost:3000

${C_BOLD}Then smoke-test the gateway${C_RESET}:
    curl http://localhost:8787/health
    # => {"ok":true,"version":"0.0.1","db":"up", ...}

    curl http://localhost:8787/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer tokensmart-dev-key" \\
      -d '{
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Say hello"}]
      }'
    # NOTE: requires OPENAI_API_KEY (or another provider) to be set in $GW_ENV

${C_BOLD}URLs${C_RESET}:
    Gateway   http://localhost:8787
    Dashboard http://localhost:3000
    pgweb     http://localhost:8081

${C_DIM}Need to add provider credentials?  Edit $GW_ENV and restart the gateway.${C_RESET}
${C_DIM}Need auth on the dashboard?       Set TOKENSMART_AUTH_ENABLED=1 in $DB_ENV.${C_RESET}
${C_DIM}Need to start over?               docker compose down -v && rm $GW_ENV $DB_ENV && ./install.sh${C_RESET}
EOF
fi
