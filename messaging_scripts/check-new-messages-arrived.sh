#!/bin/bash
# AI Maestro - Quick check for new messages (runs after each Claude response)

SESSION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      SESSION_OVERRIDE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: check-new-messages-arrived.sh [--session name]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

SESSION="${SESSION_OVERRIDE:-${AIMAESTRO_SESSION:-}}"
if [ -z "$SESSION" ]; then
  exit 0
fi

MESSAGE_ROOT=${AIMAESTRO_MESSAGE_DIR:-$HOME/.aimaestro/messages}
INBOX="$MESSAGE_ROOT/inbox/$SESSION"
UNREAD=$(ls "$INBOX"/*.json 2>/dev/null | wc -l | tr -d ' ')

if [ "$UNREAD" -gt 0 ]; then
  echo "" >&2
  echo "💬 New message(s) received! You have $UNREAD unread message(s)" >&2
  echo "   Run: cat \"$INBOX\"/*.json | jq" >&2
fi
