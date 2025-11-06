#!/bin/bash
# AI Maestro Session Engine - CLI Client
# Simple bash client for interacting with session engine via IPC

SOCKET_PATH="${AIMAESTRO_IPC_SOCKET:-/tmp/aimaestro-engine.sock}"

# Check if socat is installed
if ! command -v socat &> /dev/null; then
    echo "Error: socat is required but not installed"
    echo "Install: brew install socat  (macOS) or  apt-get install socat  (Linux)"
    exit 1
fi

# Check if jq is installed (optional but recommended)
if ! command -v jq &> /dev/null; then
    echo "Warning: jq not installed, output will not be formatted"
    JQ_AVAILABLE=false
else
    JQ_AVAILABLE=true
fi

# Send IPC request
send_request() {
    local method="$1"
    local params="$2"
    local request_id="req-$(date +%s)-$$"

    local request=$(cat <<EOF
{"id":"$request_id","method":"$method","params":$params}
EOF
)

    if ! [ -S "$SOCKET_PATH" ]; then
        echo "Error: Session engine not running (socket not found at $SOCKET_PATH)"
        exit 1
    fi

    local response=$(echo "$request" | socat - UNIX-CONNECT:$SOCKET_PATH 2>&1)

    if [ $? -ne 0 ]; then
        echo "Error: Failed to connect to session engine"
        echo "$response"
        exit 1
    fi

    if [ "$JQ_AVAILABLE" = true ]; then
        echo "$response" | jq .
    else
        echo "$response"
    fi
}

# Command: list sessions
cmd_list() {
    echo "Listing all sessions..."
    send_request "list_sessions" "{}"
}

# Command: create session
cmd_create() {
    local name="$1"
    local cwd="${2:-$(pwd)}"

    if [ -z "$name" ]; then
        echo "Usage: $0 create <session-name> [working-directory]"
        exit 1
    fi

    echo "Creating session '$name' in $cwd..."

    local params=$(cat <<EOF
{"name":"$name","cwd":"$cwd","env":{}}
EOF
)

    send_request "create_session" "$params"
}

# Command: delete session
cmd_delete() {
    local session_id="$1"

    if [ -z "$session_id" ]; then
        echo "Usage: $0 delete <session-id>"
        exit 1
    fi

    echo "Deleting session '$session_id'..."
    send_request "delete_session" "{\"id\":\"$session_id\"}"
}

# Command: get metadata
cmd_info() {
    local session_id="$1"

    if [ -z "$session_id" ]; then
        echo "Usage: $0 info <session-id>"
        exit 1
    fi

    echo "Getting metadata for session '$session_id'..."
    send_request "get_metadata" "{\"id\":\"$session_id\"}"
}

# Command: get scrollback
cmd_scrollback() {
    local session_id="$1"
    local lines="${2:-100}"

    if [ -z "$session_id" ]; then
        echo "Usage: $0 scrollback <session-id> [lines]"
        exit 1
    fi

    echo "Reading last $lines lines of scrollback for '$session_id'..."
    send_request "get_scrollback" "{\"id\":\"$session_id\",\"lines\":$lines}"
}

# Command: health check
cmd_health() {
    echo "Checking session engine health..."

    if [ -S "$SOCKET_PATH" ]; then
        echo "✓ Socket exists: $SOCKET_PATH"
    else
        echo "✗ Socket not found: $SOCKET_PATH"
        exit 1
    fi

    # Try to list sessions
    if send_request "list_sessions" "{}" > /dev/null 2>&1; then
        echo "✓ Session engine responding"
    else
        echo "✗ Session engine not responding"
        exit 1
    fi

    echo "Session engine is healthy!"
}

# Main command dispatcher
main() {
    local command="$1"
    shift

    case "$command" in
        list)
            cmd_list
            ;;
        create)
            cmd_create "$@"
            ;;
        delete)
            cmd_delete "$@"
            ;;
        info)
            cmd_info "$@"
            ;;
        scrollback)
            cmd_scrollback "$@"
            ;;
        health)
            cmd_health
            ;;
        help|--help|-h|"")
            echo "AI Maestro Session Engine CLI"
            echo ""
            echo "Usage: $0 <command> [arguments]"
            echo ""
            echo "Commands:"
            echo "  list                          List all sessions"
            echo "  create <name> [dir]           Create new session"
            echo "  delete <session-id>           Delete session"
            echo "  info <session-id>             Get session metadata"
            echo "  scrollback <session-id> [n]   Read last N lines of scrollback"
            echo "  health                        Check engine health"
            echo "  help                          Show this help"
            echo ""
            echo "Environment:"
            echo "  AIMAESTRO_IPC_SOCKET          Path to engine socket (default: /tmp/aimaestro-engine.sock)"
            echo ""
            echo "Examples:"
            echo "  $0 list"
            echo "  $0 create my-session /tmp"
            echo "  $0 info my-session"
            echo "  $0 scrollback my-session 50"
            echo "  $0 delete my-session"
            ;;
        *)
            echo "Error: Unknown command '$command'"
            echo "Run '$0 help' for usage"
            exit 1
            ;;
    esac
}

main "$@"
