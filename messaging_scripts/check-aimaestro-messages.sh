#!/bin/bash
# AI Maestro - Check for unread messages
# Usage: check-aimaestro-messages.sh [--session name] [--api-url url] [--mark-read]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_common.sh"

MARK_READ=false
SESSION_OVERRIDE=""
API_OVERRIDE=""

print_usage() {
  cat <<'EOF'
Usage: check-aimaestro-messages.sh [options]

Options:
  --session <name>   Override session (defaults to $AIMAESTRO_SESSION)
  --api-url <url>    Override API base URL (defaults to host/port envs)
  --mark-read        Mark all unread messages as read after displaying
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
    --mark-read)
      MARK_READ=true
      shift
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

SESSION="$(ai_msg_resolve_session "$SESSION_OVERRIDE")"
API_BASE_URL="$(ai_msg_resolve_api_base "$API_OVERRIDE")"

RESPONSE=$(curl --silent --show-error --fail --get "${API_BASE_URL}/api/messages" \
  --data-urlencode "session=${SESSION}" \
  --data-urlencode "status=unread" \
  --data-urlencode "box=inbox" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to connect to ${API_BASE_URL}" >&2
  exit 1
fi

if ai_msg_have_jq; then
  if ! echo "$RESPONSE" | jq empty >/dev/null 2>&1; then
    echo "❌ Error: Invalid response from API" >&2
    echo "   Response: $RESPONSE" >&2
    exit 1
  fi
  API_ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
else
  if ! echo "$RESPONSE" | node -e 'const fs=require("fs"); try { JSON.parse(fs.readFileSync(0,"utf8")); } catch { process.exit(1) }' >/dev/null; then
    echo "❌ Error: Invalid response from API" >&2
    exit 1
  fi
  API_ERROR=$(echo "$RESPONSE" | node -e 'const fs=require("fs"); try { const data=JSON.parse(fs.readFileSync(0,"utf8")); console.log(data.error||""); } catch { process.exit(0) }')
fi

if [ -n "$API_ERROR" ]; then
  echo "❌ API Error: $API_ERROR" >&2
  exit 1
fi

if ai_msg_have_jq; then
  COUNT=$(echo "$RESPONSE" | jq -r '.messages | length')
else
  COUNT=$(echo "$RESPONSE" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const msgs=Array.isArray(data.messages)?data.messages:[]; console.log(msgs.length);')
fi

if [ -z "$COUNT" ] || [ "$COUNT" = "null" ] || [ "$COUNT" = "0" ]; then
  echo "📭 No unread messages"
  exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📬 You have $COUNT unread message(s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

MESSAGE_IDS=()

if ai_msg_have_jq; then
  echo "$RESPONSE" | jq -r '.messages[] |
    "\u001b[1m[\(.id)]\u001b[0m " +
    (if .priority == "urgent" then "🔴" elif .priority == "high" then "🟠" elif .priority == "normal" then "🔵" else "⚪" end) +
    " From: \u001b[36m\(.from)\u001b[0m | \(.timestamp)\n" +
    "    Subject: \(.subject)\n" +
    "    Preview: \(.preview)\n"'
  if [ "$MARK_READ" = true ]; then
    mapfile -t MESSAGE_IDS < <(echo "$RESPONSE" | jq -r '.messages[].id')
  fi
else
  echo ""
  echo "$RESPONSE" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const msgs=Array.isArray(data.messages)?data.messages:[]; for (const msg of msgs) { const pr=(msg.priority||"normal").toUpperCase(); console.log(`[${msg.id}] ${msg.subject} — ${msg.from} (${pr})`); }'
  echo ""
  echo "ℹ️  Install jq for rich message previews: brew install jq" >&2
  if [ "$MARK_READ" = true ]; then
    mapfile -t MESSAGE_IDS < <(echo "$RESPONSE" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const msgs=Array.isArray(data.messages)?data.messages:[]; for (const msg of msgs) { if (msg && msg.id) { console.log(msg.id); } }')
  fi
fi

if [ "$MARK_READ" = true ] && [ ${#MESSAGE_IDS[@]} -gt 0 ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📝 Marking messages as read..."
  for MSG_ID in "${MESSAGE_IDS[@]}"; do
    MARK_RESPONSE=$(curl --silent --show-error --fail --request PATCH "${API_BASE_URL}/api/messages?session=${SESSION}&id=${MSG_ID}&action=read" 2>&1)
    if [ $? -ne 0 ]; then
      echo "   ❌ Failed to mark ${MSG_ID:0:15}... as read"
      continue
    fi
    if ai_msg_have_jq; then
      SUCCESS=$(echo "$MARK_RESPONSE" | jq -r '.success' 2>/dev/null)
    else
      SUCCESS=$(echo "$MARK_RESPONSE" | node -e 'const fs=require("fs"); try { const data=JSON.parse(fs.readFileSync(0,"utf8")); console.log(data.success?"true":"false"); } catch { console.log("false"); }')
    fi
    if [ "$SUCCESS" = "true" ]; then
      echo "   ✅ Marked ${MSG_ID:0:15}... as read"
    else
      echo "   ❌ Failed to mark ${MSG_ID:0:15}... as read"
    fi
  done
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💡 To read full message: read-aimaestro-message.sh <message-id>"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
