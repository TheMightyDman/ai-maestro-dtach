#!/bin/bash
# AI Maestro - Send a message to another session

# Usage: send-aimaestro-message.sh <to_session> <subject> <message> [priority] [type]

if [ $# -lt 3 ]; then
  echo "Usage: send-aimaestro-message.sh <to_session> <subject> <message> [priority] [type]"
  echo ""
  echo "Arguments:"
  echo "  to_session  - Target session name (e.g., backend-architect)"
  echo "  subject     - Message subject"
  echo "  message     - Message content"
  echo "  priority    - Optional: low|normal|high|urgent (default: normal)"
  echo "  type        - Optional: request|response|notification|update (default: request)"
  echo ""
  echo "Example:"
  echo "  send-aimaestro-message.sh backend-architect \"Need API\" \"Please implement POST /api/users\" high request"
  exit 1
fi

TO_SESSION="$1"
SUBJECT="$2"
MESSAGE="$3"
PRIORITY="${4:-normal}"
TYPE="${5:-request}"

# Get current session
FROM_SESSION=$(tmux display-message -p '#S' 2>/dev/null)
if [ -z "$FROM_SESSION" ]; then
  echo "Error: Not in a tmux session"
  exit 1
fi

# Validate priority
if [[ ! "$PRIORITY" =~ ^(low|normal|high|urgent)$ ]]; then
  echo "Error: Priority must be low, normal, high, or urgent"
  exit 1
fi

# Validate type
if [[ ! "$TYPE" =~ ^(request|response|notification|update)$ ]]; then
  echo "Error: Type must be request, response, notification, or update"
  exit 1
fi

# Build JSON safely using jq to prevent injection
JSON_PAYLOAD=$(jq -n \
  --arg from "$FROM_SESSION" \
  --arg to "$TO_SESSION" \
  --arg subject "$SUBJECT" \
  --arg message "$MESSAGE" \
  --arg priority "$PRIORITY" \
  --arg type "$TYPE" \
  '{
    from: $from,
    to: $to,
    subject: $subject,
    priority: $priority,
    content: {
      type: $type,
      message: $message
    }
  }')

# Send via API and capture response with HTTP status code
API_HOST=${AIMAESTRO_API_HOST:-127.0.0.1}
API_PORT=${AIMAESTRO_API_PORT:-23000}
API_BASE_URL=${AIMAESTRO_API_URL:-http://$API_HOST:$API_PORT}

RESPONSE=$(curl -s -S -w "\n%{http_code}" -X POST "${API_BASE_URL}/api/messages" \
  -H 'Content-Type: application/json' \
  -d "$JSON_PAYLOAD" 2>&1)

CURL_STATUS=$?

if [ $CURL_STATUS -ne 0 ]; then
  echo "❌ Failed to send message"
  echo "   Error: $RESPONSE"
  exit 1
fi

# Extract HTTP code and body
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "201" ]; then
  echo "✅ Message sent to $TO_SESSION"
  echo "   From: $FROM_SESSION"
  echo "   Subject: $SUBJECT"
  echo "   Priority: $PRIORITY"
else
  echo "❌ Failed to send message (HTTP $HTTP_CODE)"
  ERROR_MSG=$(echo "$BODY" | jq -r '.error // "Unknown error"' 2>/dev/null)
  if [ -n "$ERROR_MSG" ] && [ "$ERROR_MSG" != "null" ]; then
    echo "   Error: $ERROR_MSG"
  fi
  exit 1
fi
