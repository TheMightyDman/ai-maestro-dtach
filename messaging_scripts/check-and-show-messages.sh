#!/bin/bash
# AI Maestro - Display detailed inbox messages

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_common.sh"

SESSION_OVERRIDE=""
API_OVERRIDE=""

print_usage() {
  cat <<'EOF'
Usage: check-and-show-messages.sh [options]

Options:
  --session <name>   Override session (defaults to $AIMAESTRO_SESSION)
  --api-url <url>    Override API base URL
  --help, -h         Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      SESSION_OVERRIDE="$2"
      shift 2
      ;;
    --api-url)
      API_OVERRIDE="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      print_usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if ! ai_msg_have_jq; then
  echo "Error: jq is required for check-and-show-messages.sh. Install with: brew install jq" >&2
  exit 1
fi

SESSION="$(ai_msg_resolve_session "$SESSION_OVERRIDE")"
API_BASE_URL="$(ai_msg_resolve_api_base "$API_OVERRIDE")"

RESPONSE=$(curl --silent --show-error --fail --get "${API_BASE_URL}/api/messages" \
  --data-urlencode "session=${SESSION}" \
  --data-urlencode "box=inbox" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to connect to ${API_BASE_URL}" >&2
  exit 1
fi

if ! echo "$RESPONSE" | jq empty >/dev/null 2>&1; then
  echo "❌ Error: Invalid response from API" >&2
  echo "   Response: $RESPONSE" >&2
  exit 1
fi

API_ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
if [ -n "$API_ERROR" ]; then
  echo "❌ API Error: $API_ERROR" >&2
  exit 1
fi

COUNT=$(echo "$RESPONSE" | jq -r '.messages | length')
if [ "$COUNT" -eq 0 ]; then
  echo "📭 Inbox is empty"
  exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📬 Inbox for ${SESSION} — $COUNT message(s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "$RESPONSE" | jq -r '.messages[] |
  "ID: \(.id)\n" +
  "From: \(.from)\n" +
  "Subject: \(.subject)\n" +
  "Priority: \(.priority | ascii_upcase)\n" +
  "Status: \(.status)\n" +
  "Type: \(.content.type)\n" +
  "Timestamp: \(.timestamp | split("T")[0] + " " + (.timestamp | split("T")[1] | split(".")[0]))\n" +
  "Preview: \(.preview)\n" +
  "────────────────────────────────────────\n"'

echo "💡 Use read-aimaestro-message.sh <id> to view full content."
