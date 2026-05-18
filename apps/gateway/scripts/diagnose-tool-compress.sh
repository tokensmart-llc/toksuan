#!/usr/bin/env bash
# Diagnostic script for the tool-result compressor end-to-end flow.
#
# Run from anywhere:
#   ./apps/gateway/scripts/diagnose-tool-compress.sh
#
# Walks the full chain and tells you which station the signal got lost at:
#
#   1. Is the gateway up on :8787?
#   2. Is TOKENSMART_TOOL_COMPRESS_ENABLED=1 visible in its env?
#   3. Does a real request return the X-Tokensmart-Tool-Compress-* headers?
#   4. Did it write a row into the requests table with the compressor tags?
#   5. Does the dashboard's getSavingsBreakdown SQL surface it?
#
# Read-only — never modifies your DB or .env.
set -u

GATEWAY="${GATEWAY_URL:-http://localhost:8787}"
API_KEY="${TOKENSMART_API_KEY:-tokensmart-dev-key}"
SQLITE_PATH_DEFAULT="apps/gateway/data/tokensmart-dev.db"

# Resolve repo root (this script is in apps/gateway/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SQLITE_PATH="${TOKENSMART_SQLITE_PATH:-$REPO_ROOT/$SQLITE_PATH_DEFAULT}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

bold "=== TokSuan tool-result compressor — end-to-end diagnostic ==="
echo

# -- 1. Gateway reachable? ---------------------------------------------------
bold "[1/5] gateway reachable on $GATEWAY"
if curl -sS --max-time 3 "$GATEWAY/health" > /dev/null 2>&1; then
  green "  ✓ /health responded"
else
  red "  ✗ couldn't reach $GATEWAY/health"
  echo "    Is \`bun run dev\` running in apps/gateway? Or set GATEWAY_URL=..."
  exit 1
fi
echo

# -- 2. Compressor flag visible to the running gateway -----------------------
bold "[2/5] env flag in apps/gateway/.env"
ENV_FILE="$REPO_ROOT/apps/gateway/.env"
if [ -f "$ENV_FILE" ]; then
  if grep -q '^TOKENSMART_TOOL_COMPRESS_ENABLED=1' "$ENV_FILE" 2>/dev/null; then
    green "  ✓ TOKENSMART_TOOL_COMPRESS_ENABLED=1 in .env"
  else
    if grep -q '^TOKENSMART_TOOL_COMPRESS_ENABLED=' "$ENV_FILE" 2>/dev/null; then
      red "  ✗ TOKENSMART_TOOL_COMPRESS_ENABLED is set but not to '1':"
      grep '^TOKENSMART_TOOL_COMPRESS_ENABLED=' "$ENV_FILE"
    else
      red "  ✗ TOKENSMART_TOOL_COMPRESS_ENABLED missing from .env"
    fi
    yellow "    Add this to apps/gateway/.env and RESTART bun run dev:"
    echo "        TOKENSMART_TOOL_COMPRESS_ENABLED=1"
    echo
    echo "    (env is read once at gateway boot — editing .env without"
    echo "     restart keeps the old value in memory.)"
  fi
else
  red "  ✗ apps/gateway/.env not found at $ENV_FILE"
fi
echo

# -- 3. Send a request and look for the response headers ---------------------
bold "[3/5] sending a request with a compressible tool message"
TMP_RESP=$(mktemp)
TMP_HEADERS=$(mktemp)
trap 'rm -f "$TMP_RESP" "$TMP_HEADERS"' EXIT

# A tool message big enough to exceed the 500-char min threshold and shaped
# like a git status. The OPENAI_API_KEY may be a placeholder — that's fine,
# the compressor runs BEFORE the upstream call.
PAYLOAD=$(cat <<'JSON'
{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "user", "content": "Did the build pass?"},
    {"role": "assistant", "content": "let me check", "tool_calls": [
      {"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\"cmd\":\"git status\"}"}}
    ]},
    {"role": "tool", "tool_call_id":"call_1", "content": "On branch develop\nYour branch is up to date with 'origin/develop'.\n\nChanges to be committed:\n  (use \"git restore --staged <file>...\" to unstage)\n        modified:   apps/gateway/src/routes/file_0.ts\n        modified:   apps/gateway/src/routes/file_1.ts\n        modified:   apps/gateway/src/routes/file_2.ts\n        modified:   apps/gateway/src/routes/file_3.ts\n        modified:   apps/gateway/src/routes/file_4.ts\n        modified:   apps/gateway/src/routes/file_5.ts\n        modified:   apps/gateway/src/routes/file_6.ts\n        modified:   apps/gateway/src/routes/file_7.ts\n        modified:   apps/gateway/src/routes/file_8.ts\n        modified:   apps/gateway/src/routes/file_9.ts\n\nUntracked files:\n  (use \"git add <file>...\" to include in what will be committed)\n        scratch/notes_0.md\n        scratch/notes_1.md\n        scratch/notes_2.md\n        scratch/notes_3.md\n        scratch/notes_4.md\n"}
  ]
}
JSON
)

HTTP_STATUS=$(curl -sS -o "$TMP_RESP" -D "$TMP_HEADERS" -w "%{http_code}" \
  --max-time 30 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  "$GATEWAY/v1/chat/completions" \
  -d "$PAYLOAD" || echo "curl-error")

dim "  HTTP $HTTP_STATUS  (200 = OpenAI key worked; 401/502 = upstream rejected, but compressor still ran)"
echo

CHARS=$(awk 'tolower($0) ~ /^x-tokensmart-tool-compress-chars-saved:/ { sub(/\r$/, ""); print $2 }' "$TMP_HEADERS" | tr -d '[:space:]')
CENTS=$(awk 'tolower($0) ~ /^x-tokensmart-tool-compress-saved-cents:/ { sub(/\r$/, ""); print $2 }' "$TMP_HEADERS" | tr -d '[:space:]')
ASKED=$(awk 'tolower($0) ~ /^x-tokensmart-asked-model:/ { sub(/\r$/, ""); print $2 }' "$TMP_HEADERS" | tr -d '[:space:]')
LANDED=$(awk 'tolower($0) ~ /^x-tokensmart-landed-model:/ { sub(/\r$/, ""); print $2 }' "$TMP_HEADERS" | tr -d '[:space:]')
REQID=$(awk 'tolower($0) ~ /^x-tokensmart-request-id:/ { sub(/\r$/, ""); print $2 }' "$TMP_HEADERS" | tr -d '[:space:]')

echo "  X-Tokensmart-Asked-Model:  ${ASKED:-(missing)}"
echo "  X-Tokensmart-Landed-Model: ${LANDED:-(missing)}"
echo "  X-Tokensmart-Request-Id:   ${REQID:-(missing)}"
if [ -n "$CHARS" ]; then
  green "  ✓ X-Tokensmart-Tool-Compress-Chars-Saved: $CHARS  (compressor fired!)"
  if [ -n "$CENTS" ]; then
    green "  ✓ X-Tokensmart-Tool-Compress-Saved-Cents: $CENTS"
  else
    yellow "  ! X-Tokensmart-Tool-Compress-Saved-Cents missing — upstream call probably failed,"
    echo "    so we couldn't price the savings. Chars-saved is the load-bearing"
    echo "    signal here; that's what matters."
  fi
else
  red "  ✗ X-Tokensmart-Tool-Compress-Chars-Saved missing!"
  echo
  yellow "    Possible causes:"
  echo "      - TOKENSMART_TOOL_COMPRESS_ENABLED was not '1' when gateway booted"
  echo "        → fix .env, restart bun run dev"
  echo "      - The tool message was below the 500-char minMessageChars floor"
  echo "        → unlikely, this fixture is ~1.2 KiB"
  echo "      - Upstream rejected before our header stamping logic ran"
  echo "        → check the response body below"
  echo
  echo "    --- response body (first 30 lines) ---"
  head -30 "$TMP_RESP" | sed 's/^/    /'
  echo "    --- response headers (full) ---"
  sed 's/^/    /' "$TMP_HEADERS"
fi
echo

# -- 4. Did the compressor stamp tags onto the request row? -----------------
bold "[4/5] checking the requests row in SQLite"
if [ ! -f "$SQLITE_PATH" ]; then
  yellow "  - SQLite DB not found at $SQLITE_PATH"
  echo "    (set TOKENSMART_SQLITE_PATH=... if you used a different location;"
  echo "     skipping DB checks — this is fine if you're on Postgres)"
else
  if ! command -v sqlite3 > /dev/null 2>&1; then
    yellow "  - sqlite3 CLI not on PATH; skipping DB checks"
    echo "    (install via 'brew install sqlite' if you want this signal)"
  else
    APPLIED_COUNT=$(sqlite3 "$SQLITE_PATH" \
      "SELECT COUNT(*) FROM requests WHERE json_extract(tags, '\$.tool_compress_applied') = '1';" \
      2>/dev/null || echo "?")
    SAVED_SUM=$(sqlite3 "$SQLITE_PATH" \
      "SELECT COALESCE(SUM(CAST(json_extract(tags, '\$.tool_compress_chars_saved') AS INTEGER)), 0) FROM requests WHERE json_extract(tags, '\$.tool_compress_applied') = '1';" \
      2>/dev/null || echo "?")
    LATEST_TAGS=$(sqlite3 "$SQLITE_PATH" \
      "SELECT tags FROM requests ORDER BY created_at DESC LIMIT 1;" \
      2>/dev/null || echo "?")
    echo "  rows with tool_compress_applied=1: $APPLIED_COUNT"
    echo "  total chars saved across those rows: $SAVED_SUM"
    echo "  latest request tags: $LATEST_TAGS"
    if [ "$APPLIED_COUNT" = "0" ] || [ -z "$APPLIED_COUNT" ]; then
      red "  ✗ no rows have tool_compress_applied=1"
      echo "    The compressor didn't tag this request. Either flag is off"
      echo "    in the running process, or the tool message didn't trigger it."
    else
      green "  ✓ compressor tags are landing in the DB"
    fi
  fi
fi
echo

# -- 5. Dashboard signal -----------------------------------------------------
bold "[5/5] dashboard breakdown signal"
echo "  After running this script:"
echo "    1. Open http://localhost:3000/dashboard"
echo "    2. WAIT 30 SECONDS — the dashboard caches stats with a 30s TTL"
echo "       (Next.js unstable_cache). A hard refresh before the TTL"
echo "       elapses still shows the cached number."
echo "    3. Look for the 'Tool-result compression' cell in the savings"
echo "       hero card. It now appears even when the dollar total is \$0,"
echo "       as long as request count > 0."
echo
bold "=== done. ==="
