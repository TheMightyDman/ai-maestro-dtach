#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPLIT_MODE=0
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --split|--ui-only)
      SPLIT_MODE=1
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: npm run dev [-- [--split]]

Without flags this script starts the Session Engine, Terminal Gateway, and Next.js UI in one process group.
Use --split (or export AIMAESTRO_DEV_SPLIT=1) to run only the UI so you can start the other services manually.
EOF
      exit 0
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "${AIMAESTRO_DEV_SPLIT:-0}" == "1" ]]; then
  SPLIT_MODE=1
fi

export AIMAESTRO_DATA_DIR="${AIMAESTRO_DATA_DIR:-$HOME/.aimaestro}"
export AIMAESTRO_IPC_SOCKET="${AIMAESTRO_IPC_SOCKET:-$AIMAESTRO_DATA_DIR/sockets/aimaestro-engine.sock}"
export AIMAESTRO_DTACH_PATH="${AIMAESTRO_DTACH_PATH:-$ROOT_DIR/services/session-engine/dist/bin/dtach}"
export AIMAESTRO_MESSAGE_DIR="${AIMAESTRO_MESSAGE_DIR:-$AIMAESTRO_DATA_DIR/messages}"
export AIMAESTRO_EMBED_GATEWAY="${AIMAESTRO_EMBED_GATEWAY:-0}"

mkdir -p "$AIMAESTRO_DATA_DIR" "$(dirname "$AIMAESTRO_IPC_SOCKET")" "$AIMAESTRO_MESSAGE_DIR"

if [[ ! -x "$AIMAESTRO_DTACH_PATH" ]]; then
  echo "⚠️  dtach binary not found at $AIMAESTRO_DTACH_PATH"
  echo "    Run: npm run build:dtach"
fi

if [[ $SPLIT_MODE -eq 1 ]]; then
  echo "Running UI only (split mode). Start engine/gateway manually."
  cd "$ROOT_DIR"
  exec node server.mjs "${ARGS[@]}"
fi

PIDS=()

start_proc() {
  local label="$1"
  shift
  echo "▶️  Starting $label ..."
  ("$@") &
  local pid=$!
  PIDS+=($pid)
  echo "   $label PID $pid"
}

cleanup() {
  echo ""
  echo "⏹  Stopping dev stack..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"
start_proc "Session Engine" npm run engine:dev
start_proc "Terminal Gateway" npm run gateway:start
start_proc "Next.js UI" node server.mjs "${ARGS[@]}"

wait -n "${PIDS[@]}"
exit $?
