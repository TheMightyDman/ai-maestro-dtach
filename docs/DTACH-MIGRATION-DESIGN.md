# AI Maestro dtach Migration - Technical Design Document

**Version**: 1.0
**Date**: 2025-11-06
**Status**: Design Phase

## Executive Summary

This document outlines the complete technical design for migrating AI Maestro from tmux-based session management to a custom dtach-backed session engine. The goal is to eliminate external dependencies (tmux) while preserving all existing functionality and improving portability.

## Table of Contents

1. [Current Architecture Analysis](#current-architecture-analysis)
2. [Target Architecture](#target-architecture)
3. [Session Engine Design](#session-engine-design)
4. [Migration Strategy](#migration-strategy)
5. [Implementation Phases](#implementation-phases)
6. [API Contracts](#api-contracts)
7. [Testing Strategy](#testing-strategy)
8. [Risk Analysis](#risk-analysis)

---

## Current Architecture Analysis

### tmux Dependency Map

**28 files affected across 4 categories:**

#### Core tmux Libraries (2 files)
- `lib/tmux.ts` - Command execution wrapper
- `services/terminal-gateway/src/tmux.ts` - Duplicate (consolidation needed)

#### Session Management (4 files)
- `services/terminal-gateway/src/session/PtySession.ts` - PTY spawning via `tmux attach-session`
- `services/terminal-gateway/src/session/SessionManager.ts` - Session pooling, scroll management
- `services/terminal-gateway/src/session/RingBuffer.ts` - Scrollback buffer (independent)
- `services/terminal-gateway/src/metrics.ts` - Session metrics

#### API Routes (6 files)
- `app/api/sessions/route.ts` - Session discovery via `tmux list-sessions`
- `app/api/sessions/create/route.ts` - Session creation
- `app/api/sessions/[id]/route.ts` - Session deletion
- `app/api/sessions/[id]/rename/route.ts` - Session renaming
- `app/api/sessions/restore/route.ts` - Session restoration
- `app/api/sessions/activity/route.ts` - Activity tracking

#### Messaging Scripts (6 files)
- `messaging_scripts/check-aimaestro-messages.sh`
- `messaging_scripts/send-aimaestro-message.sh`
- `messaging_scripts/send-tmux-message.sh` (direct tmux integration)
- `messaging_scripts/forward-aimaestro-message.sh`
- `messaging_scripts/read-aimaestro-message.sh`
- `messaging_scripts/check-and-show-messages.sh`

#### Configuration & Setup (2 files)
- `scripts/setup-tmux.sh` - tmux configuration
- `install.sh` - Installer with tmux setup

#### Documentation (8 files)
- `docs/TMUX-PATH-FIX.md` - Environment variable handling
- `docs/REQUIREMENTS.md` - Installation prerequisites
- `docs/OPERATIONS-GUIDE.md` - Session management
- `CLAUDE.md` - Development guidance
- `README.md` - Project overview
- Plus 3 more with tmux references

### tmux Commands Used

| Command | Usage | Files | Critical? |
|---------|-------|-------|-----------|
| `tmux list-sessions` | Session discovery | 3 | ✅ Critical |
| `tmux has-session -t <name>` | Existence checks | 5 | ✅ Critical |
| `tmux new-session -d -s <name>` | Session creation | 2 | ✅ Critical |
| `tmux kill-session -t <name>` | Session deletion | 1 | ✅ Critical |
| `tmux rename-session -t <old> <new>` | Session renaming | 1 | ✅ Critical |
| `tmux attach-session -t <name>` | PTY spawning | 1 | ✅ Critical |
| `tmux display-message -p '#S'` | Session name detection | 8+ | ✅ Critical |
| `tmux display-message -t <name> -p <format>` | Metadata retrieval | 3 | ✅ Critical |
| `tmux capture-pane -t <name> -p` | Terminal history | 1 | ✅ Critical |
| `tmux send-keys -t <name> -X <cmd>` | Scroll control | 5 | ⚠️ Optional |
| `tmux copy-mode -t <name>` | Scroll mode | 1 | ⚠️ Optional |

### Key Constraints from tmux

1. **Session Naming**: `^[A-Za-z0-9_-]+$` (enforced by `normalizeSessionName()`)
2. **Environment Isolation**: tmux freezes environment variables when server starts
3. **Alternate Screen Buffer**: Used by Claude Code CLI (like vim)
4. **Scrollback Limit**: 50,000 lines configured in setup
5. **Mouse Support**: Required for terminal interaction
6. **Copy Mode**: Manual scroll control via tmux keybindings

---

## Target Architecture

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Next.js Dashboard                        │
│  (React 18, xterm.js, WebSocket, Tailwind CSS)              │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP/WebSocket (port 3000)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Terminal Gateway (server.mjs)                   │
│  - HTTP handler (Next.js requests)                           │
│  - WebSocket handler (terminal I/O)                          │
│  - Session pooling (multi-client support)                    │
└─────────────────────┬───────────────────────────────────────┘
                      │ IPC (Unix domain socket / gRPC)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   Session Engine Daemon                      │
│  - Written in Rust (or Go)                                   │
│  - Embeds dtach binary (dist/bin/dtach)                     │
│  - Manages session registry (~/.aimaestro/sessions.json)    │
│  - Handles scrollback (ring buffer to disk)                 │
│  - Exposes IPC API (list/create/attach/delete/metadata)     │
└─────────────────────┬───────────────────────────────────────┘
                      │ Process spawning
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    dtach Binary                              │
│  - Spawned per session: dtach -n <socket> <shell>           │
│  - Unix socket: ~/.aimaestro/sockets/<session-id>.sock      │
│  - Detach/reattach support                                   │
│  - No built-in scrollback (handled by engine)               │
└─────────────────────┬───────────────────────────────────────┘
                      │ PTY
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Shell → Claude Code CLI                         │
│  (bash/zsh → claude)                                         │
└─────────────────────────────────────────────────────────────┘
```

### Key Architectural Changes

1. **Session Discovery**: `tmux list-sessions` → Read `~/.aimaestro/sessions.json`
2. **PTY Spawning**: `tmux attach-session -t X` → `dtach -a <socket-path>`
3. **Session Creation**: `tmux new-session -d` → `dtach -n <socket> <shell>`
4. **Scrollback**: `tmux capture-pane` → Read from `~/.aimaestro/scrollback/<session-id>.log`
5. **Metadata**: `tmux display-message -p '#{pane_current_path}'` → IPC call to session engine
6. **Session Naming**: Same constraints maintained for compatibility

### Benefits Over tmux

1. **Zero External Dependencies**: dtach is embedded, no user installation required
2. **Nested Support**: Can run inside existing tmux sessions without issues
3. **Lightweight**: dtach is ~1000 LOC vs tmux's ~100K+ LOC
4. **Portability**: Easier cross-platform builds (macOS, Linux, WSL)
5. **Control**: Full ownership of session lifecycle and metadata
6. **Simplicity**: No complex tmux.conf required, no environment variable freezing

---

## Session Engine Design

### Technology Choice: Rust

**Why Rust:**
- Memory safety without garbage collection
- Excellent cross-compilation support (darwin-arm64, linux-x86_64)
- High-performance IPC (tokio async runtime)
- Native process spawning and PTY handling
- Cargo build system integrates well with npm

**Alternative: Go** (if Rust expertise is limited)
- Simpler learning curve
- Good cross-compilation
- Built-in concurrency (goroutines)
- Acceptable performance for this use case

### Session Engine Architecture

#### Core Components

```rust
// src/main.rs - Daemon entry point
fn main() {
    let config = load_config();
    let engine = SessionEngine::new(config);

    // Start IPC server
    let ipc_server = IpcServer::new(engine);
    ipc_server.listen("/tmp/aimaestro-engine.sock");
}

// src/engine.rs - Session management
pub struct SessionEngine {
    registry: SessionRegistry,
    scrollback: ScrollbackManager,
    dtach_path: PathBuf,
}

impl SessionEngine {
    pub async fn list_sessions(&self) -> Vec<SessionMetadata> { ... }
    pub async fn create_session(&mut self, req: CreateSessionRequest) -> Result<SessionId> { ... }
    pub async fn attach_session(&self, id: &SessionId) -> Result<UnixStream> { ... }
    pub async fn delete_session(&mut self, id: &SessionId) -> Result<()> { ... }
    pub async fn get_metadata(&self, id: &SessionId) -> Result<SessionMetadata> { ... }
    pub async fn get_scrollback(&self, id: &SessionId, lines: usize) -> Result<String> { ... }
}

// src/registry.rs - Session registry
pub struct SessionRegistry {
    sessions: HashMap<SessionId, SessionEntry>,
    file_path: PathBuf, // ~/.aimaestro/sessions.json
}

#[derive(Serialize, Deserialize)]
pub struct SessionEntry {
    pub id: String,
    pub socket_path: PathBuf,
    pub cwd: PathBuf,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub env: HashMap<String, String>,
    pub agent_id: Option<String>,
}

// src/scrollback.rs - Scrollback management
pub struct ScrollbackManager {
    base_dir: PathBuf, // ~/.aimaestro/scrollback/
    max_lines: usize,  // 50,000 default
}

impl ScrollbackManager {
    pub async fn capture_output(&mut self, session_id: &SessionId, data: &[u8]) { ... }
    pub async fn read_history(&self, session_id: &SessionId, lines: usize) -> Result<String> { ... }
}

// src/dtach.rs - dtach binary wrapper
pub struct DtachProcess {
    socket_path: PathBuf,
    pid: Option<u32>,
}

impl DtachProcess {
    pub async fn spawn_new(socket: PathBuf, shell: PathBuf, cwd: PathBuf) -> Result<Self> {
        // Execute: dtach -n <socket> <shell>
    }

    pub async fn attach(socket: PathBuf) -> Result<UnixStream> {
        // Execute: dtach -a <socket>
        // Return raw PTY stream
    }
}

// src/ipc.rs - IPC server
pub struct IpcServer {
    engine: Arc<Mutex<SessionEngine>>,
    socket_path: PathBuf,
}

// IPC Protocol (JSON-RPC style)
#[derive(Serialize, Deserialize)]
pub enum IpcRequest {
    ListSessions,
    CreateSession { name: String, cwd: PathBuf, env: HashMap<String, String> },
    AttachSession { id: String },
    DeleteSession { id: String },
    GetMetadata { id: String },
    GetScrollback { id: String, lines: usize },
}
```

#### Session Registry Format

**File**: `~/.aimaestro/sessions.json`

```json
{
  "version": "1.0",
  "sessions": {
    "backend-api": {
      "id": "backend-api",
      "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock",
      "cwd": "/Users/dan/projects/backend",
      "created_at": "2025-11-06T14:30:00Z",
      "last_activity": "2025-11-06T15:45:00Z",
      "env": {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "SHELL": "/bin/zsh"
      },
      "agent_id": "agent-123",
      "status": "active"
    }
  }
}
```

#### Directory Structure

```
~/.aimaestro/
├── sessions.json          # Session registry
├── sockets/               # dtach socket files
│   ├── backend-api.sock
│   └── frontend-dev.sock
├── scrollback/            # Ring buffer logs
│   ├── backend-api.log
│   └── frontend-dev.log
└── engine.log             # Session engine logs
```

---

## Migration Strategy

### Phase 0: Foundations (Week 1)

**Goals:**
- Remove tmux assets
- Vendor dtach source
- Design session interface
- Setup CI/CD for dtach builds

**Tasks:**
1. Archive tmux-specific files:
   - Move `scripts/setup-tmux.sh` → `archive/`
   - Move `docs/TMUX-PATH-FIX.md` → `archive/`
   - Keep messaging scripts for migration reference

2. Vendor dtach source:
   - Clone dtach from http://dtach.sourceforge.net/
   - Place in `services/session-engine/vendor/dtach/`
   - Add CMakeLists.txt for reproducible builds
   - Test compilation on macOS and Linux

3. Design TypeScript session interface:
   - Create `lib/session-engine.ts` with abstract interface
   - Define IPC protocol types
   - Create mocks for parallel frontend development

4. Setup GitHub Actions:
   - Add workflow: `.github/workflows/build-dtach.yml`
   - Build for darwin-arm64, darwin-x86_64, linux-x86_64
   - Publish artifacts to `public/bin/`

**Success Criteria:**
- dtach compiles on macOS and Linux
- TypeScript interface defined and reviewed
- CI pipeline produces platform-specific binaries

---

### Phase 1: Core Session Engine (Week 2-3)

**Goals:**
- Implement Rust session engine daemon
- Session registry with persistence
- Scrollback capture system
- Unit and integration tests

**Tasks:**
1. Initialize Rust project:
   ```bash
   cd services/session-engine
   cargo init --name aimaestro-engine
   ```

2. Implement core modules:
   - `src/engine.rs` - Main session engine
   - `src/registry.rs` - Session persistence
   - `src/scrollback.rs` - Ring buffer to disk
   - `src/dtach.rs` - dtach spawning
   - `src/ipc.rs` - Unix domain socket server

3. Session lifecycle:
   - Create: Validate name → spawn dtach → save to registry
   - Attach: Read socket path → dtach attach → return PTY stream
   - Delete: Kill dtach process → remove from registry → cleanup files

4. Scrollback capture:
   - Intercept stdout/stderr from dtach
   - Write to `~/.aimaestro/scrollback/<id>.log` with ring buffer logic
   - Support reading last N lines efficiently

5. Testing:
   - Unit tests for each module
   - Integration tests: Create → attach → write → read → delete
   - Multi-client attach test (2+ clients to same session)
   - Crash recovery test (engine restart with active sessions)

**Success Criteria:**
- All tests pass on macOS and Linux
- Session CRUD operations work
- Scrollback capture < 5% CPU overhead
- Engine handles 20+ concurrent sessions

---

### Phase 2: Gateway Integration (Week 4)

**Goals:**
- Replace tmux calls in terminal gateway
- Integrate with session engine IPC
- Maintain multi-client pooling
- Preserve scroll functionality

**Tasks:**
1. Refactor `PtySession.ts`:
   ```typescript
   // OLD
   this.pty = spawn('tmux', ['attach-session', '-t', sessionName], ...)

   // NEW
   const socket = await sessionEngine.getSocketPath(sessionName)
   this.pty = spawn(dtachPath, ['-a', socket], ...)
   ```

2. Update `SessionManager.ts`:
   - Replace `runTmuxCommand('has-session')` → `sessionEngine.hasSession()`
   - Replace `runTmuxCommand('capture-pane')` → `sessionEngine.getScrollback()`
   - Remove tmux scroll commands (`send-keys -X`, `copy-mode`)
   - Implement client-side scroll via xterm.js viewport

3. Create `lib/session-engine-client.ts`:
   - IPC client wrapper (Unix socket communication)
   - Connection pooling
   - Error handling with retries
   - TypeScript types matching Rust IPC protocol

4. Scroll reimplementation:
   - Remove tmux dependency (hooks/useWebSocket.ts:354)
   - Use xterm.js `onScroll` event for viewport changes
   - Fetch additional history via `sessionEngine.getScrollback()`
   - Maintain scroll position across session switches

5. Testing:
   - Test PTY spawn → attach → write → read → dispose
   - Test multi-client attach (session pooling)
   - Test scroll up/down with history loading
   - Test session switch without losing state

**Success Criteria:**
- All existing terminal functionality preserved
- No tmux commands executed by gateway
- Scroll performance < 100ms latency
- Multi-client sessions work (2+ browsers → 1 session)

---

### Phase 3: API & Messaging Layer (Week 5)

**Goals:**
- Migrate API routes to session engine
- Update messaging scripts
- Migrate agent registry

**Tasks:**
1. Update API routes:
   ```typescript
   // app/api/sessions/route.ts
   // OLD: const output = await runTmuxCommand(['list-sessions'])
   // NEW: const sessions = await sessionEngine.listSessions()
   ```

   - `app/api/sessions/route.ts` - List sessions
   - `app/api/sessions/create/route.ts` - Create session
   - `app/api/sessions/[id]/route.ts` - Delete session
   - `app/api/sessions/[id]/rename/route.ts` - Rename session

2. Rewrite messaging scripts:
   - Remove `tmux display-message -p '#S'` calls
   - Add environment variable: `AIMAESTRO_SESSION_ID` (set by session engine)
   - Update scripts to read from env var or call API endpoint

   ```bash
   # OLD
   SESSION_NAME=$(tmux display-message -p '#S')

   # NEW
   SESSION_NAME=${AIMAESTRO_SESSION_ID:-$(curl -s http://localhost:3000/api/session/current)}
   ```

3. Migrate agent registry:
   - Update `lib/agent-registry.ts`:
     - Change field: `tmuxSessionName` → `sessionId`
   - Create data migration script:
     - Read existing `~/.aimaestro/agent-registry.json`
     - Map tmux session names to new session IDs
     - Write back with new schema

4. Notification system:
   - Replace `tmux display-message -t <session>` with WebSocket broadcast
   - Add `/api/notifications` endpoint
   - Messaging scripts POST to API instead of calling tmux

**Success Criteria:**
- All API routes work without tmux
- Messaging scripts function correctly
- Agent registry migration successful
- No data loss during migration

---

### Phase 4: Frontend & UX Refresh (Week 6)

**Goals:**
- Update UI copy/terminology
- Enhance onboarding
- Refresh documentation
- Add diagnostics view

**Tasks:**
1. UI terminology audit:
   - Search for "tmux" references in components
   - Update tooltips, labels, help text
   - Update icons if needed (keep existing visual style)

2. Onboarding improvements:
   - Add "Getting Started" modal on first launch
   - Highlight dtach-backed features:
     - True detach/reattach
     - Nested session support
     - No external dependencies
   - Show keyboard shortcuts (xterm.js only, no tmux keybindings)

3. Documentation refresh:
   - Update `README.md`:
     - Remove tmux from prerequisites
     - Add "Built-in session engine" as feature
   - Update `docs/REQUIREMENTS.md`:
     - Remove tmux 3.0+ requirement
     - Add supported platforms (macOS 12.0+, Linux, WSL)
   - Update `docs/OPERATIONS-GUIDE.md`:
     - Replace tmux commands with UI actions
     - Add troubleshooting for session engine
   - Create `docs/SESSION-ENGINE-ARCHITECTURE.md`:
     - Document dtach integration
     - Explain registry format
     - Scrollback capture details

4. Diagnostics view:
   - New component: `components/DiagnosticsPanel.tsx`
   - Show:
     - Session engine status (running/stopped)
     - Active sessions count
     - Socket directory listing
     - Build hashes (dtach version, engine version)
   - Add health check endpoint: `/api/health`

**Success Criteria:**
- No user-facing tmux references
- Documentation accurate and complete
- Diagnostics view aids troubleshooting

---

### Phase 5: Packaging, QA, Release (Week 7-8)

**Goals:**
- Reproducible bundles
- End-to-end testing
- Observability setup
- Release preparation

**Tasks:**
1. Bundle creation:
   - Use `pkg` or `nexe` for standalone executable
   - Include:
     - Next.js UI (built)
     - Terminal gateway (built)
     - Session engine binary (Rust)
     - dtach binary (embedded)
   - Postinstall script:
     - Set executable permissions (`chmod +x`)
     - Create `~/.aimaestro/` directories
     - Copy default config

2. End-to-end testing:
   - Test matrix:
     - macOS 12.0+ (arm64, x86_64)
     - Ubuntu 20.04+
     - WSL2 (Ubuntu)
   - Test scenarios:
     - Fresh install → create session → attach → detach → delete
     - Multi-client attach (2 browsers)
     - History replay (create session, output 10K lines, scroll up)
     - Messaging (send message between sessions)
     - Agent linking (assign agent to session)
     - Session restore after engine restart

3. Observability:
   - Structured logging:
     - JSON format
     - Levels: DEBUG, INFO, WARN, ERROR
     - Fields: timestamp, session_id, operation, duration
   - Prometheus metrics:
     - `aimaestro_sessions_active` (gauge)
     - `aimaestro_sessions_created_total` (counter)
     - `aimaestro_bytes_sent_total` (counter)
     - `aimaestro_bytes_received_total` (counter)
   - Crash watchdog:
     - Detect engine crashes
     - Auto-restart with exponential backoff
     - Alert user via UI notification

4. Release preparation:
   - Versioning:
     - Bump to v1.0.0 (major release)
     - Update package.json, Cargo.toml
   - Artifacts:
     - macOS (arm64): aimaestro-darwin-arm64.tar.gz
     - macOS (x86_64): aimaestro-darwin-x86_64.tar.gz
     - Linux (x86_64): aimaestro-linux-x86_64.tar.gz
   - Release notes:
     - Breaking changes (tmux removed)
     - New features (embedded session engine)
     - Migration guide (from v0.x)
   - Onboarding materials:
     - Installation guide
     - Quick start tutorial
     - Video walkthrough (optional)

**Success Criteria:**
- All tests pass on target platforms
- Bundles install and run without errors
- Metrics and logs work correctly
- Release artifacts ready for distribution

---

## API Contracts

### IPC Protocol (JSON-RPC)

**Transport**: Unix domain socket at `/tmp/aimaestro-engine.sock`

#### Request Format

```json
{
  "id": "req-123",
  "method": "list_sessions",
  "params": {}
}
```

#### Response Format

```json
{
  "id": "req-123",
  "result": { ... },
  "error": null
}
```

#### Methods

**1. list_sessions**

Request:
```json
{ "method": "list_sessions", "params": {} }
```

Response:
```json
{
  "result": {
    "sessions": [
      {
        "id": "backend-api",
        "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock",
        "cwd": "/Users/dan/projects/backend",
        "created_at": "2025-11-06T14:30:00Z",
        "last_activity": "2025-11-06T15:45:00Z",
        "status": "active",
        "agent_id": "agent-123"
      }
    ]
  }
}
```

**2. create_session**

Request:
```json
{
  "method": "create_session",
  "params": {
    "name": "backend-api",
    "cwd": "/Users/dan/projects/backend",
    "env": { "PATH": "/usr/local/bin:/usr/bin" }
  }
}
```

Response:
```json
{
  "result": {
    "id": "backend-api",
    "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock"
  }
}
```

**3. attach_session**

Request:
```json
{
  "method": "attach_session",
  "params": { "id": "backend-api" }
}
```

Response:
```json
{
  "result": {
    "socket_path": "/Users/dan/.aimaestro/sockets/backend-api.sock"
  }
}
```

*(Gateway then spawns dtach with this socket)*

**4. delete_session**

Request:
```json
{
  "method": "delete_session",
  "params": { "id": "backend-api" }
}
```

Response:
```json
{ "result": { "deleted": true } }
```

**5. get_metadata**

Request:
```json
{
  "method": "get_metadata",
  "params": { "id": "backend-api" }
}
```

Response:
```json
{
  "result": {
    "id": "backend-api",
    "cwd": "/Users/dan/projects/backend",
    "created_at": "2025-11-06T14:30:00Z",
    "last_activity": "2025-11-06T15:45:00Z",
    "env": { "PATH": "/usr/local/bin:/usr/bin" },
    "agent_id": "agent-123"
  }
}
```

**6. get_scrollback**

Request:
```json
{
  "method": "get_scrollback",
  "params": { "id": "backend-api", "lines": 1000 }
}
```

Response:
```json
{
  "result": {
    "content": "...(last 1000 lines of output)...",
    "total_lines": 5432
  }
}
```

---

## Testing Strategy

### Unit Tests

**Session Engine (Rust)**
- Registry: Save/load/update sessions
- Scrollback: Ring buffer write/read
- dtach spawning: Create socket → spawn → verify PID
- IPC server: Parse requests → execute → return response

**Gateway (TypeScript)**
- Session engine client: Connect → send request → parse response
- PTY session: Spawn dtach → write → read → dispose
- Session manager: Multi-client pooling logic

### Integration Tests

1. **Session Lifecycle**
   - Create session → verify in registry
   - Attach → write "hello" → read "hello"
   - Delete → verify socket removed

2. **Multi-Client**
   - Create session
   - Attach client 1 → write "hello"
   - Attach client 2 → should receive "hello"
   - Client 1 disconnects → client 2 still works

3. **Scrollback**
   - Create session
   - Output 10,000 lines
   - Read last 1,000 lines → verify content
   - Verify ring buffer wraps correctly at 50,000 lines

4. **Crash Recovery**
   - Create 3 sessions
   - Kill session engine
   - Restart engine
   - Verify sessions restored from registry

### End-to-End Tests (Playwright)

1. **Happy Path**
   - Open dashboard
   - Create new session "test1"
   - Verify appears in sidebar
   - Click session → terminal loads
   - Type "echo hello" → verify output
   - Delete session → verify removed

2. **Multi-Browser**
   - Browser 1: Create session "shared"
   - Browser 2: Open same session
   - Browser 1: Type "hello"
   - Browser 2: Verify receives "hello"

3. **History Replay**
   - Create session, output 5,000 lines
   - Disconnect
   - Reconnect → verify history replays

---

## Risk Analysis

### High-Risk Areas

1. **PTY Compatibility**
   - **Risk**: dtach PTY behavior differs from tmux
   - **Mitigation**: Extensive testing with Claude Code CLI, vim, less
   - **Fallback**: Document known issues, provide workarounds

2. **Scrollback Performance**
   - **Risk**: Ring buffer to disk introduces I/O overhead
   - **Mitigation**: Use memory-mapped files, async writes
   - **Monitoring**: Track write latency, add backpressure if needed

3. **Data Migration**
   - **Risk**: Existing agent registry data loss
   - **Mitigation**: Create backup before migration, provide rollback script
   - **Testing**: Test migration on sample data before release

4. **Platform Differences**
   - **Risk**: dtach behavior varies on macOS vs Linux
   - **Mitigation**: Test on all platforms, document differences
   - **Fallback**: Platform-specific code paths if necessary

### Medium-Risk Areas

1. **IPC Reliability**
   - **Risk**: Unix socket communication failures
   - **Mitigation**: Add retries, health checks, connection pooling

2. **Bundle Size**
   - **Risk**: Standalone binary becomes too large (>100MB)
   - **Mitigation**: Strip debug symbols, use compression

3. **Scroll UX**
   - **Risk**: Client-side scroll feels different from tmux
   - **Mitigation**: User testing, iterate on scroll behavior

### Low-Risk Areas

1. **UI Changes**: Minimal, mostly terminology updates
2. **Documentation**: Straightforward rewrite
3. **Messaging Scripts**: Well-defined API contracts

---

## Success Metrics

### Technical Metrics

- **Test Coverage**: >80% for session engine, >70% for gateway
- **Performance**: Session creation < 500ms, attach < 200ms
- **Reliability**: <1% session loss rate during engine restart
- **Memory**: <50MB per 10 sessions

### User Experience Metrics

- **Installation Time**: <5 minutes from download to first session
- **Error Rate**: <5% of session operations fail
- **Support Tickets**: <10 issues per 100 users in first month

---

## Appendix

### dtach Command Reference

```bash
# Create new session
dtach -n /tmp/mysession.sock /bin/bash

# Attach to existing session
dtach -a /tmp/mysession.sock

# Create and attach
dtach -c /tmp/mysession.sock /bin/bash

# Detach: Ctrl-\ (default)
```

### Rust Dependencies

```toml
[dependencies]
tokio = { version = "1.35", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
anyhow = "1.0"
chrono = { version = "0.4", features = ["serde"] }
nix = "0.27"  # For PTY and Unix socket handling
```

### Build Commands

```bash
# Build dtach
cd services/session-engine/vendor/dtach
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
cp build/dtach ../../../dist/bin/dtach

# Build session engine
cd services/session-engine
cargo build --release
cp target/release/aimaestro-engine ../../dist/bin/

# Build Next.js app
npm run build

# Create bundle
npm run package
```

---

**Document Version History**

- v1.0 (2025-11-06): Initial design document
