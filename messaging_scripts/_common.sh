#!/bin/bash
# Shared helpers for AI Maestro messaging scripts

ai_msg_resolve_session() {
  local override="$1"
  local session="${override:-${AIMAESTRO_SESSION:-}}"
  if [ -z "$session" ]; then
    echo "Error: Session name not provided. Use --session <name> or export AIMAESTRO_SESSION." >&2
    exit 1
  fi
  echo "$session"
}

ai_msg_resolve_api_base() {
  local override="$1"
  if [ -n "$override" ]; then
    echo "$override"
    return
  }
  if [ -n "${AIMAESTRO_API_URL:-}" ]; then
    echo "$AIMAESTRO_API_URL"
    return
  }
  local host="${AIMAESTRO_API_HOST:-127.0.0.1}"
  local port="${AIMAESTRO_API_PORT:-23000}"
  echo "http://${host}:${port}"
}

ai_msg_http() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  local curl_args=(-s -S -w $'\n%{http_code}' -X "$method" "$url")
  if [ -n "$data" ]; then
    curl_args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  curl "${curl_args[@]}"
}

ai_msg_handle_response() {
  local response="$1"
  local success_code="$2"
  local on_success="$3"

  local http_code
  http_code=$(echo "$response" | tail -n1)
  local body
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" = "$success_code" ]; then
    if [ -n "$on_success" ]; then
      echo "$body" | eval "$on_success"
    fi
    return 0
  fi

  local error_msg
  if command -v jq >/dev/null 2>&1; then
    error_msg=$(echo "$body" | jq -r '.error // empty' 2>/dev/null)
  else
    error_msg=$(echo "$body" | node -e 'const fs=require("fs");try{const data=JSON.parse(fs.readFileSync(0,"utf8"));console.log(data.error||"");}catch{process.exit(0)}' 2>/dev/null)
  fi
  echo "❌ Request failed (HTTP $http_code)" >&2
  if [ -n "$error_msg" ]; then
    echo "   Error: $error_msg" >&2
  fi
  return 1
}

ai_msg_have_jq() {
  command -v jq >/dev/null 2>&1
}

ai_msg_needs_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required for this script. Please install it and retry." >&2
    exit 1
  fi
}
