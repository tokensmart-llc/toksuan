#!/usr/bin/env bash
# End-to-end demo: send one realistic tool-result of each compressible
# shape through the gateway, then summarise how much the compressor
# actually saved. Prints a tidy table at the end + an SQLite-backed
# breakdown that mirrors what the dashboard renders.
#
# Run:
#   ./apps/gateway/scripts/demo-tool-compress.sh
#
# Env:
#   GATEWAY_URL              default http://localhost:8787
#   TOKENSMART_API_KEY       default tokensmart-dev-key  (single-tenant seed)
#   TOKENSMART_SQLITE_PATH   default apps/gateway/data/tokensmart-dev.db
#
# What this proves:
#   1. Each of the 5 content shapes the compressor recognises (git_status,
#      git_diff, shell_listing, stack_trace, json_logs) ACTUALLY trips
#      the right filter against a running gateway (not just in unit tests).
#   2. The response header X-Tokensmart-Tool-Compress-Chars-Saved is
#      non-zero on every call.
#   3. The SQLite row for each call carries the `tool_compress_*` tag.
#   4. The aggregate matches what /dashboard would show.
#
# Safe to re-run — adds N more rows each invocation (no cleanup).

set -u

GATEWAY="${GATEWAY_URL:-http://localhost:8787}"
API_KEY="${TOKENSMART_API_KEY:-tokensmart-dev-key}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SQLITE_PATH="${TOKENSMART_SQLITE_PATH:-$REPO_ROOT/apps/gateway/data/tokensmart-dev.db}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red() { printf '\033[31m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
dim() { printf '\033[2m%s\033[0m' "$*"; }

# Pre-flight: gateway up?
if ! curl -sS --max-time 3 "$GATEWAY/health" > /dev/null 2>&1; then
  red "✗ Can't reach $GATEWAY/health"; echo
  echo "  Start the gateway:"
  echo "    cd apps/gateway && bun run dev"
  exit 1
fi

# ---- fixtures ---------------------------------------------------------------
# Each fixture is a single string ≥500 bytes so it actually trips the
# compressor's min-size floor. Synthesized to look like real Bash-tool
# stdout that a coding agent would replay back to the model.

GIT_STATUS_FIXTURE=$(cat <<'EOF'
On branch develop
Your branch is up to date with 'origin/develop'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
        modified:   apps/gateway/src/routes/chat.ts
        modified:   apps/gateway/src/config.ts
        modified:   apps/gateway/src/tool-result-compressor.ts
        modified:   apps/dashboard/src/lib/db.ts
        modified:   apps/dashboard/src/lib/sql-driver.ts
        modified:   apps/dashboard/src/app/dashboard/DashboardPage.tsx
        modified:   apps/dashboard/src/app/billing/page.tsx
        modified:   apps/dashboard/src/i18n/types.ts
        modified:   apps/dashboard/src/i18n/en.ts
        modified:   apps/dashboard/src/i18n/zh-CN.ts
        modified:   apps/dashboard/next.config.ts
        modified:   apps/dashboard/package.json
        modified:   README.md
        modified:   docs/positioning.md
        modified:   apps/gateway/test/tool-result-compressor.test.ts
        modified:   apps/gateway/test/routing-decision-headers.test.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
        scratch/notes_1.md
        scratch/notes_2.md
        scratch/draft.md
EOF
)

GIT_DIFF_FIXTURE=$(cat <<'EOF'
diff --git a/apps/gateway/src/tool-result-compressor.ts b/apps/gateway/src/tool-result-compressor.ts
index 0000000..abcdef1 100644
--- a/apps/gateway/src/tool-result-compressor.ts
+++ b/apps/gateway/src/tool-result-compressor.ts
@@ -1,5 +1,5 @@
-/**
- * Old top-level docstring describing the legacy compressor behaviour
- * across many lines of prose that take a lot of input tokens.
+/**
+ * New compressor implementation - shape-aware filters for tool output.
+ * Includes git_status, git_diff, stack_trace, json_logs, shell_listing.
  */
@@ -10,12 +10,18 @@
-export function legacyCompress(content: string): string {
-  return content;
+export type CompressionShape =
+  | "git_status"
+  | "git_diff"
+  | "shell_listing"
+  | "stack_trace"
+  | "json_logs"
+  | "ansi_text"
+  | "unknown";
diff --git a/apps/gateway/test/tool-result-compressor.test.ts b/apps/gateway/test/tool-result-compressor.test.ts
new file mode 100644
index 0000000..abcdef2
--- /dev/null
+++ b/apps/gateway/test/tool-result-compressor.test.ts
@@ -0,0 +1,12 @@
+import { describe, expect, test } from "bun:test";
+import { compressContent, detectShape } from "../src/tool-result-compressor";
+
+describe("detectShape", () => {
+  test("identifies git_status", () => { /* ... */ });
+  test("identifies git_diff", () => { /* ... */ });
+  test("identifies stack_trace", () => { /* ... */ });
+});
EOF
)

SHELL_LISTING_FIXTURE=$(
  for i in {1..80}; do
    printf -- "-rw-r--r--  1 user staff  %d Jan %d 12:%d node_modules/some/pkg/file_%d.js\n" \
      $((i * 137)) $(((i % 28) + 1)) $(((i * 7) % 60)) "$i"
  done
)

STACK_TRACE_FIXTURE=$(
  printf "Error: ECONNRESET while contacting upstream\n"
  for i in {1..40}; do
    printf "    at frame_%d (/app/src/long/path/segment/file_%d.ts:%d:%d)\n" \
      "$i" "$i" $((i + 1)) $(((i * 3) + 7))
  done
  printf "    at processTicksAndRejections (node:internal/process/task_queues:96:5)\n"
)

JSON_LOGS_FIXTURE=$(
  for i in {1..50}; do
    printf '{"level":"info","msg":"step ok","seq":%d,"t":"2026-05-18T19:%d"}\n' "$i" $((i % 60))
  done
  for i in {1..15}; do
    printf '{"level":"warn","msg":"slow query","ms":%d}\n' $((1500 + i * 50))
  done
  printf '{"level":"error","msg":"db conn lost","ms":30000}\n'
)

# JSON-escape a multi-line string into a single line suitable for the
# `content` field of a tool message. Replaces backslash, double-quote,
# newline, tab, carriage-return — the four chars JSON forbids in a
# string literal.
json_escape() {
  python3 -c "import json, sys; print(json.dumps(sys.stdin.read())[1:-1])"
}

send_one() {
  local name="$1"
  local raw_content="$2"
  local escaped_content
  escaped_content="$(printf '%s' "$raw_content" | json_escape)"

  # Per-call nonce in the USER message keeps the request fingerprint
  # unique on repeated runs. Without this the loop detector trips on
  # the second invocation of the script and blocks identical payloads
  # with HTTP 403 — correct production behaviour, but it muddies a
  # demo where the user just wants to re-run the script.
  local nonce
  nonce=$(date +%s%N)$RANDOM

  local payload
  payload=$(cat <<JSON
{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "user", "content": "What does the tool output say? (run $nonce)"},
    {"role": "assistant", "content": "let me check", "tool_calls": [
      {"id":"call_1","type":"function","function":{"name":"shell","arguments":"{}"}}
    ]},
    {"role": "tool", "tool_call_id": "call_1", "content": "$escaped_content"}
  ]
}
JSON
)

  local headers_tmp
  headers_tmp=$(mktemp)
  curl -sS -o /dev/null -D "$headers_tmp" --max-time 30 \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$GATEWAY/v1/chat/completions" > /dev/null || true

  local chars cents shape http_status request_id
  chars=$(awk 'tolower($0) ~ /^x-tokensmart-tool-compress-chars-saved:/ { sub(/\r$/, ""); print $2 }' "$headers_tmp" | tr -d '[:space:]')
  cents=$(awk 'tolower($0) ~ /^x-tokensmart-tool-compress-saved-cents:/ { sub(/\r$/, ""); print $2 }' "$headers_tmp" | tr -d '[:space:]')
  http_status=$(awk 'NR==1 { print $2 }' "$headers_tmp" | tr -d '[:space:]')
  # Use the request-id header so the shape lookup hits the EXACT row
  # this curl produced. Earlier versions did `ORDER BY DESC LIMIT 1`
  # which races against parallel runs of this script.
  request_id=$(awk 'tolower($0) ~ /^x-tokensmart-request-id:/ { sub(/\r$/, ""); print $2 }' "$headers_tmp" | tr -d '[:space:]')

  if [ -n "$request_id" ] && command -v sqlite3 > /dev/null 2>&1 && [ -f "$SQLITE_PATH" ]; then
    shape=$(sqlite3 "$SQLITE_PATH" \
      "SELECT json_extract(tags, '\$.tool_compress_shape') FROM requests \
       WHERE id = '$request_id';" 2>/dev/null)
  else
    shape=""
  fi

  rm -f "$headers_tmp"

  printf "  %-15s  HTTP %-3s  shape=%-15s  chars-saved=%-6s  cents-saved=%s\n" \
    "$name" "$http_status" "${shape:-—}" "${chars:-—}" "${cents:-—}"
}

bold "=== TokSuan tool-result compressor — end-to-end demo ==="
echo
dim "  Gateway:   $GATEWAY"; echo
dim "  API key:   $API_KEY"; echo
dim "  SQLite:    $SQLITE_PATH"; echo
echo

bold "[1] Sending one request per recognised shape"
echo
echo "  shape           HTTP       detected         compressor savings"
echo "  --------------  ---------  ---------------  --------------------------"
send_one "git_status"     "$GIT_STATUS_FIXTURE"
send_one "git_diff"       "$GIT_DIFF_FIXTURE"
send_one "shell_listing"  "$SHELL_LISTING_FIXTURE"
send_one "stack_trace"    "$STACK_TRACE_FIXTURE"
send_one "json_logs"      "$JSON_LOGS_FIXTURE"
echo
dim "  HTTP 401/502 is fine — your OPENAI_API_KEY in apps/gateway/.env"; echo
dim "  is a placeholder, so upstream rejects. The compressor still ran"; echo
dim "  (chars-saved is the load-bearing signal here)."; echo
echo

bold "[2] Aggregate rolled up from SQLite (matches /dashboard hero card)"
echo
if [ ! -f "$SQLITE_PATH" ]; then
  yellow "  - SQLite DB not found at $SQLITE_PATH"; echo
  echo "    (skipping aggregate — set TOKENSMART_SQLITE_PATH if you used a different location)"
elif ! command -v sqlite3 > /dev/null 2>&1; then
  yellow "  - sqlite3 CLI not on PATH; skipping aggregate"; echo
  echo "    (install via 'brew install sqlite' to enable this output)"
else
  sqlite3 -column -header "$SQLITE_PATH" <<SQL
SELECT
  COUNT(*) AS req_count,
  SUM(CAST(json_extract(tags, '\$.tool_compress_chars_saved') AS INTEGER)) AS total_chars_saved,
  ROUND(SUM(CAST(json_extract(tags, '\$.tool_compress_tokens_saved_est') AS INTEGER)), 0)
    AS total_tokens_saved_est,
  SUM(CAST(json_extract(tags, '\$.tool_compress_micro_cents_saved_est') AS INTEGER)) AS total_micro_cents_saved
FROM requests
WHERE json_extract(tags, '\$.tool_compress_applied') = '1'
  AND created_at > datetime('now', '-30 days');
SQL
  echo
  bold "    by shape (last 30 days)"
  sqlite3 -column -header "$SQLITE_PATH" <<SQL
SELECT
  json_extract(tags, '\$.tool_compress_shape') AS shape,
  COUNT(*) AS hits,
  SUM(CAST(json_extract(tags, '\$.tool_compress_chars_saved') AS INTEGER)) AS chars_saved
FROM requests
WHERE json_extract(tags, '\$.tool_compress_applied') = '1'
  AND created_at > datetime('now', '-30 days')
GROUP BY shape
ORDER BY chars_saved DESC;
SQL
fi
echo

bold "[3] Where to see it visually"
echo
echo "    Dashboard:    http://localhost:3000/dashboard"
echo "                  Look for the 'Tool-result compression' cell in the"
echo "                  'Saved · last 30 days' hero card. Wait ~30s after"
echo "                  this script finishes — the dashboard caches its"
echo "                  stats with a 30s TTL."
echo
echo "    Direct SQL preview (no dashboard required):"
echo "                  bun run --cwd apps/gateway preview:dashboard-savings"
echo
echo "    Pure-module unit demo (no gateway, no DB):"
echo "                  bun run --cwd apps/gateway preview:tool-compress"
echo
bold "=== done. ==="
