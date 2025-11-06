#!/bin/bash
# AI Maestro - Check for unread messages
# Usage: check-aimaestro-messages.sh [--mark-read]

MARK_READ=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --mark-read)
      MARK_READ=true
      shift
      ;;
    --help|-h)
      echo "Usage: check-aimaestro-messages.sh [--mark-read]"
      echo ""
      echo "Check for unread messages in your inbox."
      echo ""
      echo "Options:"
      echo "  --mark-read    Mark all messages as read after displaying"
      echo "  --help, -h     Show this help message"
      echo ""
      echo "Examples:"
      echo "  check-aimaestro-messages.sh              # List unread messages"
      echo "  check-aimaestro-messages.sh --mark-read  # List and mark as read"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Get current session
SESSION=$(tmux display-message -p '#S' 2>/dev/null)
if [ -z "$SESSION" ]; then
  echo "Error: Not in a tmux session"
  exit 1
fi

API_HOST=${AIMAESTRO_API_HOST:-127.0.0.1}
API_PORT=${AIMAESTRO_API_PORT:-23000}
API_BASE_URL=${AIMAESTRO_API_URL:-http://$API_HOST:$API_PORT}

# Fetch unread messages via API
RESPONSE=$(curl --silent --show-error --fail --get "${API_BASE_URL}/api/messages" \
  --data-urlencode "session=${SESSION}" \
  --data-urlencode "status=unread" \
  --data-urlencode "box=inbox" 2>&1)

# Check if API call was successful
if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to connect to AI Maestro API"
  echo "   Make sure the dashboard is running (${API_BASE_URL})"
  exit 1
fi

# Check if response is valid JSON
if ! echo "$RESPONSE" | jq empty 2>/dev/null; then
  echo "❌ Error: Invalid response from API"
  echo "   Response: $RESPONSE"
  echo ""
  echo "💡 Troubleshooting:"
  echo "   - Check that AI Maestro is running: pm2 list"
  echo "   - Restart if needed: pm2 restart ai-maestro"
  exit 1
fi

# Check for API errors
API_ERROR=$(echo "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)
if [ -n "$API_ERROR" ]; then
  echo "❌ API Error: $API_ERROR"
  exit 1
fi

# Parse message count
COUNT=$(echo "$RESPONSE" | jq -r '.messages | length' 2>/dev/null)

if [ -z "$COUNT" ] || [ "$COUNT" = "null" ] || [ "$COUNT" = "0" ]; then
  echo "📭 No unread messages"
  exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📬 You have $COUNT unread message(s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Display messages
MESSAGE_IDS=()
echo "$RESPONSE" | jq -r '.messages[] |
  "\u001b[1m[\(.id)]\u001b[0m " +
  (if .priority == "urgent" then "🔴"
   elif .priority == "high" then "🟠"
   elif .priority == "normal" then "🔵"
   else "⚪" end) +
  " From: \u001b[36m\(.from)\u001b[0m | \(.timestamp)\n" +
  "    Subject: \(.subject)\n" +
  "    Preview: \(.preview)\n"'

# Store message IDs if we need to mark as read
if [ "$MARK_READ" = true ]; then
  mapfile -t MESSAGE_IDS < <(echo "$RESPONSE" | jq -r '.messages[].id')

  if [ ${#MESSAGE_IDS[@]} -gt 0 ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📝 Marking messages as read..."

    for MSG_ID in "${MESSAGE_IDS[@]}"; do
      MARK_RESPONSE=$(curl --silent --show-error --fail --request PATCH "${API_BASE_URL}/api/messages?session=${SESSION}&id=${MSG_ID}&action=read" 2>&1)
      if [ $? -ne 0 ]; then
        echo "   ❌ Failed to mark ${MSG_ID:0:15}... as read"
        continue
      fi
      SUCCESS=$(echo "$MARK_RESPONSE" | jq -r '.success' 2>/dev/null)

      if [ "$SUCCESS" = "true" ]; then
        echo "   ✅ Marked ${MSG_ID:0:15}... as read"
      else
        echo "   ❌ Failed to mark ${MSG_ID:0:15}... as read"
      fi
    done

    echo ""
    echo "✅ All messages marked as read"
  fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💡 To read full message: read-aimaestro-message.sh <message-id>"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
