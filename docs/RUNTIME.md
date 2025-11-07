# AI Maestro Runtime Guide

Run the three services in separate terminals so the UI, gateway, and engine stay online and reconnect cleanly.

## Environment Variables (recommended)

- `AIMAESTRO_DATA_DIR` — writable dir for registry/sockets/scrollback
  Example: `export AIMAESTRO_DATA_DIR="$HOME/.aimaestro"`
- `AIMAESTRO_IPC_SOCKET` — engine’s Unix socket path
  Example: `export AIMAESTRO_IPC_SOCKET="$AIMAESTRO_DATA_DIR/sockets/aimaestro-engine.sock"`
- `AIMAESTRO_DTACH_PATH` — dtach binary to use
  Example: `export AIMAESTRO_DTACH_PATH="$PWD/services/session-engine/dist/bin/dtach"`

## Build Prerequisites

- Build dtach once: `npm run build:dtach`
- Build engine: `npm run build:engine`
- Build gateway: `npm run gateway:build`

## Start Services

- Quick start (all-in-one): `npm run dev`
  - Spawns the Session Engine, Terminal Gateway, and Next.js UI with sensible defaults for `AIMAESTRO_DATA_DIR`, `AIMAESTRO_IPC_SOCKET`, and `AIMAESTRO_DTACH_PATH`.
  - Use `npm run dev -- --split` (or `AIMAESTRO_DEV_SPLIT=1 npm run dev`) to run only the UI if you want to launch the other services manually for debugging.

- Manual terminals (if you prefer separate panes):
  - Terminal A — Session Engine: `npm run engine:dev`
    - Expect: `IPC server listening on …/aimaestro-engine.sock`
  - Terminal B — Terminal Gateway: `npm run gateway:start`
    - Expect: `listening on ws://127.0.0.1:23001/term`
  - Terminal C — Next.js UI: `npm run dev -- --split`
    - UI at http://127.0.0.1:23000

## Listing and Attaching dtach Sessions (outside Maestro)

- Socket directory (default): `$HOME/.aimaestro/sockets`
- List sockets: `ls -l $HOME/.aimaestro/sockets/*.sock 2>/dev/null || echo "No dtach sockets"`
- Attach to a session: `dtach -a $HOME/.aimaestro/sockets/<name>.sock`
- Create a manual session: `dtach -n $HOME/.aimaestro/sockets/test.sock /bin/bash`

## Notes

- Sessions are hosted by dtach on your system. The engine orchestrates them (creates, tracks metadata, cleans up) and the gateway proxies I/O to the browser.
- If you change `AIMAESTRO_DATA_DIR`, point the UI/gateway and engine to the same socket path via `AIMAESTRO_IPC_SOCKET`.
- To supervise processes, consider PM2 or systemd units that export the env vars above.

## Messaging Quickstart

- Send a message:
  curl -X POST http://127.0.0.1:23000/api/messages \
    -H 'Content-Type: application/json' \
    -d '{
      "from": "session-A",
      "to": "session-B",
      "subject": "Hello",
      "content": { "type": "notification", "message": "It works!" },
      "priority": "normal"
    }'

- List inbox:  curl "/api/messages?session=session-B&box=inbox"
- List sent:   curl "/api/messages?session=session-A&box=sent"
- Unread count: curl "/api/messages?session=session-B&action=unread-count"

## Observability & Metrics

- The Terminal Gateway exposes Prometheus metrics at `/metrics`. Set `TERMINAL_METRICS_TOKEN` to require a bearer token:
  ```bash
  export TERMINAL_METRICS_TOKEN="my-secret-token"
  curl -H "Authorization: Bearer $TERMINAL_METRICS_TOKEN" http://127.0.0.1:23001/metrics
  ```
- Session activity snapshots (JSON) live at `/activity`. Protect with `TERMINAL_ACTIVITY_TOKEN` (falls back to `TERMINAL_METRICS_TOKEN` if unset):
  ```bash
  export TERMINAL_ACTIVITY_TOKEN="activity-token"
  curl -s -H "Authorization: Bearer $TERMINAL_ACTIVITY_TOKEN" http://127.0.0.1:23001/activity | jq
  ```
  Each entry includes `session`, `clients`, `leaderId`, `paused`, `lastActivity`, and `lastActivityIso`.
- Key gateway metrics now available:
  - `maestro_gateway_active_sessions` — total dtach sessions managed.
  - `maestro_gateway_connected_clients{session="<name>"}` — live client count per session.
  - `maestro_gateway_session_paused{session="<name>"}` — 1 when a session is paused due to backpressure.
  - `maestro_gateway_session_last_activity_timestamp{session="<name>"}` — seconds since epoch of last PTY activity.
- Use these endpoints to feed Grafana/alerts and to confirm session activity when debugging reconnect issues.
