#!/usr/bin/env bash
# smoke.sh — exercise the TokSuan wire-up with a Hermes-shaped request.
#
# Usage:
#   export TOKENSMART_BASE_URL="http://localhost:8787/v1"   # or hosted URL
#   export TOKENSMART_API_KEY="ts_your_project_key_here"
#   ./smoke.sh
#
# Optional overrides:
#   MODEL          — model id to route (default: gpt-4o-mini)
#   HERMES_SESSION — x-ts-session value (default: smoke-$EPOCHSECONDS)
#   HERMES_PLATFORM — x-ts-channel value (default: cli)

set -euo pipefail

: "${TOKENSMART_BASE_URL:?set TOKENSMART_BASE_URL, e.g. http://localhost:8787/v1}"
: "${TOKENSMART_API_KEY:?set TOKENSMART_API_KEY, e.g. ts_xxxxxxxx}"

MODEL="${MODEL:-gpt-4o-mini}"
HERMES_PLATFORM="${HERMES_PLATFORM:-cli}"
HERMES_SESSION="${HERMES_SESSION:-smoke-$(date +%s)}"

echo "→ POST ${TOKENSMART_BASE_URL}/chat/completions"
echo "  model:   ${MODEL}"
echo "  agent:   hermes"
echo "  channel: ${HERMES_PLATFORM}"
echo "  session: ${HERMES_SESSION}"
echo

curl -sS "${TOKENSMART_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${TOKENSMART_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "x-ts-agent: hermes" \
  -H "x-ts-channel: ${HERMES_PLATFORM}" \
  -H "x-ts-session: ${HERMES_SESSION}" \
  -H "x-ts-turn: 1" \
  -D /tmp/tokensmart-smoke-headers \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [
      {\"role\": \"system\", \"content\": \"You are running a smoke test.\"},
      {\"role\": \"user\", \"content\": \"Reply with one short sentence acknowledging this is a smoke test.\"}
    ]
  }" | python3 -c "import sys, json; d=json.loads(sys.stdin.read()); print(d.get('choices',[{}])[0].get('message',{}).get('content','(no content)'))"

echo
echo "↩ TokSuan response headers:"
grep -i '^x-tokensmart\|^x-request-id' /tmp/tokensmart-smoke-headers || true

echo
echo "Open the dashboard and click into the row matching X-Tokensmart-Request-Id above."
