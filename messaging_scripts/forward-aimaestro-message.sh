#!/bin/bash
# Forward a message via the AI Maestro messaging API

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_common.sh"

ai_msg_have_jq || {
  echo "Error: jq is required for forward-aimaestro-message.sh. Install with: brew install jq" >&2
  exit 1
}

SESSION_OVERRIDE=""
API_OVERRIDE=""
POSITIONAL=()

print_usage() {
  cat <<'EOF'
Usage: forward-aimaestro-message.sh [options] <message-id|latest> <recipient-session> "[optional note]"

Options:
  --session <name>   Override session (defaults to $AIMAESTRO_SESSION)
  --api-url <url>    Override API base URL
  --help, -h         Show this help message

Use "latest" as the message ID to forward the most recent inbox message.
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
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

while [[ $# -gt 0 ]]; do
  POSITIONAL+=("$1")
  shift
done

if [ ${#POSITIONAL[@]} -lt 2 ]; then
  print_usage
  exit 1
fi

MESSAGE_ID="${POSITIONAL[0]}"
RECIPIENT="${POSITIONAL[1]}"
FORWARD_NOTE="${POSITIONAL[2]:-}"

SESSION="$(ai_msg_resolve_session "$SESSION_OVERRIDE")"
API_BASE_URL="$(ai_msg_resolve_api_base "$API_OVERRIDE")"

if [ "$SESSION" = "$RECIPIENT" ]; then
  echo "Error: Cannot forward to the same session." >&2
  exit 1
fi

resolve_message_id() {
  if [ "$MESSAGE_ID" != "latest" ]; then
    echo "$MESSAGE_ID"
    return
  fi

  LIST=$(curl --silent --show-error --fail --get "${API_BASE_URL}/api/messages" \
    --data-urlencode "session=${SESSION}" \
    --data-urlencode "box=inbox" 2>&1)
  if [ $? -ne 0 ]; then
    echo "❌ Unable to fetch inbox to determine latest message." >&2
    exit 1
  fi
  if ai_msg_have_jq; then
    ID=$(echo "$LIST" | jq -r '.messages[0].id // empty')
  else
    ID=$(echo "$LIST" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const msgs=Array.isArray(data.messages)?data.messages:[]; console.log(msgs[0]?.id||"");')
  fi
  if [ -z "$ID" ]; then
    echo "No messages available to forward." >&2
    exit 1
  fi
  echo "$ID"
}

MESSAGE_ID_RESOLVED="$(resolve_message_id)"

PAYLOAD=$(jq -n \
  --arg id "$MESSAGE_ID_RESOLVED" \
  --arg from "$SESSION" \
  --arg to "$RECIPIENT" \
  --arg note "$FORWARD_NOTE" \
  '{
    messageId: $id,
    fromSession: $from,
    toSession: $to
  } + (if ($note | length) > 0 then {forwardNote: $note} else {} end)')

RESPONSE=$(ai_msg_http POST "${API_BASE_URL}/api/messages/forward" "$PAYLOAD")
if [ $? -ne 0 ]; then
  exit 1
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  SUBJECT=$(echo "$BODY" | jq -r '.forwardedMessage.subject // "Message"')
  echo "✅ Forwarded \"$SUBJECT\" to $RECIPIENT"
  exit 0
fi

ERROR_MSG=$(echo "$BODY" | jq -r '.error // empty')
echo "❌ Failed to forward message (HTTP $HTTP_CODE)" >&2
if [ -n "$ERROR_MSG" ]; then
  echo "   Error: $ERROR_MSG" >&2
fi
exit 1
