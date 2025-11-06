# AI Maestro Session Engine

**dtach-backed session management daemon for AI Maestro**

## Overview

The session engine is a Rust daemon that manages dtach-based terminal sessions, replacing tmux as the session backend. It provides:

- **Session lifecycle management**: Create, list, attach, delete sessions
- **Persistent registry**: Session metadata stored in `~/.aimaestro/sessions.json`
- **Scrollback capture**: Terminal output logged to `~/.aimaestro/scrollback/`
- **IPC API**: Unix domain socket for gateway communication

## Architecture

```
Terminal Gateway (Node.js)
        ↓ IPC (Unix socket)
Session Engine Daemon (Rust)
        ↓ Process spawning
dtach Binary (embedded)
        ↓ PTY
Shell → Claude Code CLI
```

## Building

### Prerequisites

- Rust 1.70+ (install via [rustup](https://rustup.rs/))
- dtach source (vendored in `vendor/dtach/`)

### Build dtach

```bash
cd vendor/dtach
./configure
make
cp dtach ../../dist/bin/
```

### Build session engine

```bash
cargo build --release
cp target/release/aimaestro-engine ../../dist/bin/
```

### Quick build (from project root)

```bash
npm run build:engine
```

## Running

```bash
# Development (with logging)
RUST_LOG=info cargo run

# Production
./dist/bin/aimaestro-engine
```

## Configuration

Environment variables:

- `AIMAESTRO_DTACH_PATH`: Path to dtach binary (default: `./dist/bin/dtach`)
- `AIMAESTRO_MAX_SCROLLBACK`: Max scrollback lines per session (default: 50000)
- `HOME`: User home directory (required, for `~/.aimaestro/`)

## Directory Structure

```
~/.aimaestro/
├── sessions.json          # Session registry
├── sockets/               # dtach socket files
│   ├── session-1.sock
│   └── session-2.sock
├── scrollback/            # Terminal output logs
│   ├── session-1.log
│   └── session-2.log
└── engine.log             # Engine logs (if enabled)
```

## IPC Protocol

**Transport**: Unix domain socket at `/tmp/aimaestro-engine.sock`

**Format**: JSON-RPC-style messages (one per line)

### Request

```json
{
  "id": "req-123",
  "method": "list_sessions",
  "params": {}
}
```

### Response

```json
{
  "id": "req-123",
  "result": {
    "sessions": [...]
  },
  "error": null
}
```

### Methods

- `list_sessions`: Get all sessions
- `create_session`: Create new session
- `attach_session`: Get socket path for attaching
- `delete_session`: Remove session
- `get_metadata`: Get session metadata
- `get_scrollback`: Read scrollback history

See `src/types.rs` for full protocol specification.

## Testing

```bash
# Unit tests
cargo test

# Integration tests
cargo test --test integration

# With logging
RUST_LOG=debug cargo test -- --nocapture
```

## Development Status

- ✅ **Phase 0 (Complete)**: Foundation - Types, modules, build system
- 🚧 **Phase 1 (In Progress)**: IPC server, integration tests
- ⏳ **Phase 2**: Gateway integration
- ⏳ **Phase 3**: API migration
- ⏳ **Phase 4**: Documentation
- ⏳ **Phase 5**: Release

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## License

Same as AI Maestro project - see [LICENSE](../../LICENSE).
