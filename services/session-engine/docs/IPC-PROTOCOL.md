# AI Maestro Session Engine - IPC Protocol

**Version**: 1.0
**Transport**: Unix Domain Socket
**Format**: JSON-RPC style (line-delimited)
**Socket Path**: `/tmp/aimaestro-engine.sock` (configurable via `AIMAESTRO_IPC_SOCKET`)

## Overview

The session engine communicates with clients (terminal gateway, CLI tools) via a Unix domain socket using JSON-RPC-style messages. Each request-response pair is a single line of JSON.

## Message Format

### Request

```json
{
  "id": "unique-request-id",
  "method": "method_name",
  "params": { ...method-specific parameters... }
}
```

### Response (Success)

```json
{
  "id": "unique-request-id",
  "result": { ...method-specific result... },
  "error": null
}
```

### Response (Error)

```json
{
  "id": "unique-request-id",
  "result": null,
  "error": "Error message describing what went wrong"
}
```

## Methods

### 1. `list_sessions`

List all active sessions.

**Request**:
```json
{
  "id": "req-001",
  "method": "list_sessions",
  "params": {}
}
```

**Response**:
```json
{
  "id": "req-001",
  "result": {
    "sessions": [
      {
        "id": "backend-api",
        "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock",
        "cwd": "/Users/dan/projects/backend",
        "created_at": "2025-11-06T14:30:00Z",
        "last_activity": "2025-11-06T15:45:00Z",
        "env": {
          "PATH": "/usr/local/bin:/usr/bin:/bin",
          "SHELL": "/bin/zsh"
        },
        "agent_id": null,
        "status": "active",
        "pid": 12345
      },
      {
        "id": "frontend-dev",
        "socket_path": "/Users/dan/.aimaestro/sockets/frontend-dev.sock",
        "cwd": "/Users/dan/projects/frontend",
        "created_at": "2025-11-06T14:35:00Z",
        "last_activity": "2025-11-06T15:40:00Z",
        "env": {
          "PATH": "/usr/local/bin:/usr/bin:/bin"
        },
        "agent_id": "agent-456",
        "status": "active",
        "pid": 12346
      }
    ]
  },
  "error": null
}
```

**Fields**:
- `sessions`: Array of session metadata objects
  - `id`: Session identifier (matches session name)
  - `socket_path`: Path to dtach socket file
  - `cwd`: Working directory where session was created
  - `created_at`: ISO 8601 timestamp of creation
  - `last_activity`: ISO 8601 timestamp of last activity
  - `env`: Environment variables captured at creation
  - `agent_id`: Optional agent identifier (if linked to AI agent)
  - `status`: Session status (`active`, `detached`, `dead`)
  - `pid`: Process ID of dtach master (if available)

---

### 2. `create_session`

Create a new session.

**Request**:
```json
{
  "id": "req-002",
  "method": "create_session",
  "params": {
    "name": "backend-api",
    "cwd": "/Users/dan/projects/backend",
    "env": {
      "PATH": "/usr/local/bin:/usr/bin:/bin",
      "SHELL": "/bin/zsh"
    },
    "shell": "/bin/zsh"
  }
}
```

**Parameters**:
- `name`: Session name (required, must match `^[A-Za-z0-9_-]+$`)
- `cwd`: Working directory (required)
- `env`: Environment variables (optional, defaults to empty)
- `shell`: Shell command to execute (optional, defaults to `$SHELL` or `/bin/bash`)

**Response**:
```json
{
  "id": "req-002",
  "result": {
    "id": "backend-api",
    "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock"
  },
  "error": null
}
```

**Fields**:
- `id`: Created session identifier (same as `name` in request)
- `socket_path`: Path to dtach socket for attaching

**Errors**:
- `Invalid session name: must match ^[A-Za-z0-9_-]+$`
- `Session already exists: <name>`
- `Failed to spawn dtach process`

---

### 3. `attach_session`

Get socket path for attaching to a session.

**Request**:
```json
{
  "id": "req-003",
  "method": "attach_session",
  "params": {
    "id": "backend-api"
  }
}
```

**Response**:
```json
{
  "id": "req-003",
  "result": {
    "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock"
  },
  "error": null
}
```

**Fields**:
- `socket_path`: Path to dtach socket file

**Usage**: Client should then spawn `dtach -a <socket_path>` via node-pty or similar.

**Errors**:
- `Session not found: <id>`

---

### 4. `delete_session`

Delete a session (kills dtach process and removes socket).

**Request**:
```json
{
  "id": "req-004",
  "method": "delete_session",
  "params": {
    "id": "backend-api"
  }
}
```

**Response**:
```json
{
  "id": "req-004",
  "result": {
    "deleted": true
  },
  "error": null
}
```

**Side Effects**:
- Removes session from registry
- Deletes dtach socket file
- Deletes scrollback log file

**Errors**:
- `Session not found: <id>`

---

### 5. `get_metadata`

Get detailed metadata for a specific session.

**Request**:
```json
{
  "id": "req-005",
  "method": "get_metadata",
  "params": {
    "id": "backend-api"
  }
}
```

**Response**:
```json
{
  "id": "req-005",
  "result": {
    "id": "backend-api",
    "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock",
    "cwd": "/Users/dan/projects/backend",
    "created_at": "2025-11-06T14:30:00Z",
    "last_activity": "2025-11-06T15:45:00Z",
    "env": {
      "PATH": "/usr/local/bin:/usr/bin:/bin"
    },
    "agent_id": null,
    "status": "active",
    "pid": 12345
  },
  "error": null
}
```

**Errors**:
- `Session not found: <id>`

---

### 6. `get_scrollback`

Read scrollback history for a session.

**Request**:
```json
{
  "id": "req-006",
  "method": "get_scrollback",
  "params": {
    "id": "backend-api",
    "lines": 1000
  }
}
```

**Parameters**:
- `id`: Session identifier
- `lines`: Number of lines to read (from end of log)

**Response**:
```json
{
  "id": "req-006",
  "result": {
    "content": "... last 1000 lines of terminal output ...",
    "total_lines": 5432
  },
  "error": null
}
```

**Fields**:
- `content`: Scrollback content (last N lines, newline-separated)
- `total_lines`: Total lines in scrollback log

**Note**: If scrollback file doesn't exist, returns empty content with `total_lines: 0`.

**Errors**:
- None (returns empty content if session not found)

---

## Client Implementation Examples

### TypeScript (Node.js)

```typescript
import { Socket } from 'net'

async function sendIpcRequest(method: string, params: any): Promise<any> {
  const socket = new Socket()
  const requestId = `req-${Date.now()}`

  return new Promise((resolve, reject) => {
    socket.connect('/tmp/aimaestro-engine.sock', () => {
      const request = JSON.stringify({ id: requestId, method, params })
      socket.write(request + '\n')
    })

    let responseData = ''
    socket.on('data', (data) => {
      responseData += data.toString()
      try {
        const response = JSON.parse(responseData)
        socket.destroy()

        if (response.error) {
          reject(new Error(response.error))
        } else {
          resolve(response.result)
        }
      } catch (e) {
        // Not complete JSON yet
      }
    })

    socket.on('error', reject)
  })
}

// Example usage
const sessions = await sendIpcRequest('list_sessions', {})
console.log(sessions)
```

### Python

```python
import socket
import json
import uuid

def send_ipc_request(method, params):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect('/tmp/aimaestro-engine.sock')

    request_id = f"req-{uuid.uuid4()}"
    request = json.dumps({"id": request_id, "method": method, "params": params})

    sock.sendall(request.encode('utf-8') + b'\n')

    response_data = b''
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response_data += chunk
        if b'\n' in chunk:
            break

    sock.close()

    response = json.loads(response_data.decode('utf-8'))

    if response['error']:
        raise Exception(response['error'])

    return response['result']

# Example usage
sessions = send_ipc_request('list_sessions', {})
print(sessions)
```

### Bash (with `socat`)

```bash
#!/bin/bash

REQUEST_ID="req-$(date +%s)"
METHOD="list_sessions"
PARAMS="{}"

REQUEST=$(cat <<EOF
{"id":"$REQUEST_ID","method":"$METHOD","params":$PARAMS}
EOF
)

echo "$REQUEST" | socat - UNIX-CONNECT:/tmp/aimaestro-engine.sock | jq .
```

---

## Error Handling

### Common Errors

| Error Message | Cause | Resolution |
|--------------|-------|------------|
| `Invalid session name: must match ^[A-Za-z0-9_-]+$` | Session name contains invalid characters | Use only alphanumeric, dash, underscore |
| `Session already exists: <name>` | Attempting to create duplicate session | Choose different name or delete existing |
| `Session not found: <id>` | Session doesn't exist in registry | Verify session ID via `list_sessions` |
| `Failed to spawn dtach process` | dtach binary not found or execution failed | Check `AIMAESTRO_DTACH_PATH` environment |
| `Serialization failed` | Internal JSON serialization error | Report as bug |

### Client-Side Error Handling

```typescript
try {
  const result = await sendIpcRequest('create_session', {
    name: 'my-session',
    cwd: '/tmp',
    env: {}
  })
} catch (error) {
  if (error.message.includes('Session already exists')) {
    // Handle duplicate session
  } else if (error.message.includes('Invalid session name')) {
    // Handle invalid name
  } else {
    // Handle other errors
  }
}
```

---

## Protocol Guarantees

### Concurrency

- **Thread-Safe**: Multiple clients can connect simultaneously
- **Request Isolation**: Each request is processed independently
- **Session Locking**: Engine uses Mutex to ensure session state consistency

### Reliability

- **Idempotent Reads**: `list_sessions`, `get_metadata`, `get_scrollback` can be called multiple times safely
- **Non-Idempotent Writes**: `create_session`, `delete_session` should be called once per operation
- **Connection Failures**: Client should retry failed requests with exponential backoff

### Performance

- **Typical Latency**: <10ms for most operations (depends on system load)
- **Scrollback Read**: O(lines) complexity, may be slower for large scrollback files
- **Session Creation**: 50-200ms (spawns new process)

---

## Debugging

### Enable Engine Logging

```bash
RUST_LOG=debug aimaestro-engine
```

### Monitor IPC Traffic

```bash
# On macOS
sudo dtruss -t read,write -p $(pgrep aimaestro-engine)

# On Linux
strace -e read,write -p $(pgrep aimaestro-engine)
```

### Test Connection

```bash
echo '{"id":"test-1","method":"list_sessions","params":{}}' | socat - UNIX-CONNECT:/tmp/aimaestro-engine.sock
```

---

## Version History

- **1.0.0** (2025-11-06): Initial protocol specification
  - 6 methods: list_sessions, create_session, attach_session, delete_session, get_metadata, get_scrollback
  - JSON-RPC-style line-delimited format
  - Unix domain socket transport
