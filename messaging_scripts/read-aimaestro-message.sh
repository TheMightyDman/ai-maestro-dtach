#!/bin/bash
# AI Maestro - Read a specific message and mark as read

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_common.sh"

ai_msg_have_jq || {
  echo "Error: jq is required for read-aimaestro-message.sh. Install with: brew install jq" >&2
  exit 1
}

MARK_READ=true
SESSION_OVERRIDE=""
API_OVERRIDE=""
MESSAGE_ID=""

print_usage() {
  cat <<'EOF'
Usage: read-aimaestro-message.sh [options] <message-id>

Options:
  --session <name>     Override session (defaults to $AIMAESTRO_SESSION)
  --api-url <url>      Override API base URL
  --no-mark-read       Do not mark the message as read (peek mode)
  --help, -h           Show this help message
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
    --no-mark-read)
      MARK_READ=false
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
      if [ -z "$MESSAGE_ID" ]; then
        MESSAGE_ID="$1"
      else
        echo "Unexpected argument: $1" >&2
        print_usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$MESSAGE_ID" ]; then
  print_usage
  exit 1
fi

SESSION="$(ai_msg_resolve_session "$SESSION_OVERRIDE")"
API_BASE_URL="$(ai_msg_resolve_api_base "$API_OVERRIDE")"

RESPONSE=$(curl --silent --show-error --fail --get "${API_BASE_URL}/api/messages" \
  --data-urlencode "session=${SESSION}" \
  --data-urlencode "id=${MESSAGE_ID}" \
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
  echo "❌ Error: $API_ERROR" >&2
  exit 1
fi

FROM=$(echo "$RESPONSE" | jq -r '.from')
TO=$(echo "$RESPONSE" | jq -r '.to')
SUBJECT=$(echo "$RESPONSE" | jq -r '.subject')
TIMESTAMP=$(echo "$RESPONSE" | jq -r '.timestamp')
PRIORITY=$(echo "$RESPONSE" | jq -r '.priority')
TYPE=$(echo "$RESPONSE" | jq -r '.content.type')
MESSAGE=$(echo "$RESPONSE" | jq -r '.content.message')
CONTEXT=$(echo "$RESPONSE" | jq -r '.content.context // empty')
IN_REPLY_TO=$(echo "$RESPONSE" | jq -r '.inReplyTo // empty')
FORWARDED=$(echo "$RESPONSE" | jq -r '.forwardedFrom // empty')

case "$PRIORITY" in
  urgent) PRIORITY_ICON="🔴" ;;
  high) PRIORITY_ICON="🟠" ;;
  normal) PRIORITY_ICON="🔵" ;;
  *) PRIORITY_ICON="⚪" ;;
esac

FORMATTED_TIME=$(echo "$TIMESTAMP" | sed 's/T/ /' | sed 's/\..*//')

echo "═══════════════════════════════════════════════════════════════"
echo "📧 Message: $SUBJECT"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "From:     $FROM"
echo "To:       $TO"
echo "Date:     $FORMATTED_TIME"
echo "Priority: $PRIORITY_ICON $PRIORITY"
echo "Type:     $TYPE"
if [ -n "$IN_REPLY_TO" ] && [ "$IN_REPLY_TO" != "null" ]; then
  echo "In Reply To: $IN_REPLY_TO"
fi
echo ""
echo "───────────────────────────────────────────────────────────────"
echo ""
echo "$MESSAGE"
echo ""

if [ -n "$CONTEXT" ] && [ "$CONTEXT" != "null" ] && [ "$CONTEXT" != "{}" ]; then
  echo "───────────────────────────────────────────────────────────────"
  echo "📎 Context:"
  echo ""
  echo "$RESPONSE" | jq -C '.content.context'
  echo ""
fi

if [ -n "$FORWARDED" ] && [ "$FORWARDED" != "null" ]; then
  echo "───────────────────────────────────────────────────────────────"
  echo "↪️  Forwarded Message"
  echo ""
  echo "Originally From: $(echo "$RESPONSE" | jq -r '.forwardedFrom.originalFrom')"
  echo "Originally To:   $(echo "$RESPONSE" | jq -r '.forwardedFrom.originalTo')"
  echo "Forwarded By:    $(echo "$RESPONSE" | jq -r '.forwardedFrom.forwardedBy')"
  NOTE=$(echo "$RESPONSE" | jq -r '.forwardedFrom.forwardNote // empty')
  if [ -n "$NOTE" ] && [ "$NOTE" != "null" ]; then
    echo "Forward Note:    $NOTE"
  fi
  echo ""
fi

if [ "$MARK_READ" = true ]; then
  MARK_RESPONSE=$(curl --silent --show-error --fail --request PATCH "${API_BASE_URL}/api/messages?session=${SESSION}&id=${MESSAGE_ID}&action=read" 2>&1)
  if [ $? -ne 0 ]; then
    echo "⚠️  Warning: Could not mark message as read" >&2
  else
    SUCCESS=$(echo "$MARK_RESPONSE" | jq -r '.success')
    if [ "$SUCCESS" = "true" ]; then
      echo "✅ Message marked as read"
    else
      echo "⚠️  Warning: Could not mark message as read"
    fi
  fi
else
  echo "👁️  Peek mode — message left unread"
fi

echo "═══════════════════════════════════════════════════════════════"
