# Migration Guide: tmux → dtach Session Engine

**Version**: v1.0.0 (dtach-based)
**Previous**: v0.7.x (tmux-based)

## Overview

AI Maestro v1.0.0 replaces the tmux dependency with a custom dtach-backed session engine. This guide helps you migrate from the tmux-based version to the new architecture.

## What Changed

### Architecture

**Before (v0.7.x):**
```
Next.js Dashboard → Gateway → tmux → Shell
```

**After (v1.0.0):**
```
Next.js Dashboard → Gateway → Session Engine → dtach → Shell
```

### Key Differences

| Feature | tmux (v0.7.x) | dtach (v1.0.0) |
|---------|---------------|----------------|
| **External dependency** | Yes (tmux 3.0+) | No (embedded) |
| **Session discovery** | `tmux list-sessions` | Registry file |
| **Scrollback** | tmux buffer | Engine-managed logs |
| **Configuration** | ~/.tmux.conf | Engine config |
| **Nested sessions** | Complex | Native support |
| **Environment variables** | Frozen on server start | Dynamic per session |

## Installation

### Fresh Install (v1.0.0)

```bash
git clone https://github.com/23blocks-OS/ai-maestro.git
cd ai-maestro
npm install
npm run build:all
npm start
```

### Upgrade from v0.7.x

**⚠️ Important**: Session migration is **NOT** automatic. Active tmux sessions will continue to work, but won't appear in the new dashboard.

#### Step 1: Backup current sessions

```bash
# Save tmux session names
tmux list-sessions -F '#{session_name}' > ~/aimaestro-sessions-backup.txt

# Save working directories (optional)
for session in $(tmux list-sessions -F '#{session_name}'); do
  echo "$session: $(tmux display-message -p -t $session '#{pane_current_path}')" >> ~/aimaestro-sessions-dirs.txt
done
```

#### Step 2: Update codebase

```bash
cd ai-maestro
git fetch origin
git checkout main
git pull
```

#### Step 3: Build new components

```bash
npm install  # Update dependencies
npm run build:all  # Build dtach, engine, gateway, and UI
```

#### Step 4: Migrate sessions (manual)

There is **no automatic migration tool** yet. You have two options:

##### Option A: Recreate sessions in new engine

1. Start AI Maestro v1.0.0:
   ```bash
   npm start
   ```

2. Open dashboard: http://localhost:3000

3. For each session in your backup:
   ```
   - Create new session with same name
   - cd to original working directory
   - Restart your agent (e.g., `claude`)
   ```

##### Option B: Run tmux and dtach side-by-side

Keep using tmux sessions externally while creating new sessions in AI Maestro:

```bash
# Your old tmux sessions stay active
tmux list-sessions

# AI Maestro manages new dtach sessions
curl http://localhost:3000/api/sessions
```

#### Step 5: Verify migration

```bash
# Check engine is running
ps aux | grep aimaestro-engine

# Check sessions
curl http://localhost:3000/api/sessions | jq '.sessions[] | .id'

# Check dtach sockets
ls ~/.aimaestro/sockets/
```

## Configuration Changes

### Environment Variables

**Removed** (tmux-specific):
- tmux configuration in `~/.tmux.conf`

**Added** (session engine):
- `AIMAESTRO_DTACH_PATH`: Path to dtach binary (default: auto-detect)
- `AIMAESTRO_MAX_SCROLLBACK`: Max scrollback lines (default: 50000)

### Directory Structure

**New directories** (auto-created):
```
~/.aimaestro/
├── sessions.json          # Session registry
├── sockets/               # dtach sockets
└── scrollback/            # Terminal history logs
```

**Existing directories** (unchanged):
```
~/.aimaestro/
├── messages/              # Agent messages
├── sent/                  # Sent messages
└── agent-registry.json    # Agent metadata
```

## Feature Compatibility

### ✅ Fully Compatible

- Session creation, deletion, renaming
- Terminal I/O (input/output)
- xterm.js rendering
- Agent messaging
- WebSocket connections
- Session hierarchies (categories)
- Session notes

### ⚠️ Changed Behavior

- **Scrollback**: Now managed by engine (not tmux capture-pane)
- **Environment variables**: No longer frozen at server start
- **Session naming**: Same constraints (^[A-Za-z0-9_-]+$)
- **Copy mode**: Handled by xterm.js (not tmux keybindings)

### ❌ No Longer Available

- tmux keybindings (Ctrl-b prefix)
- tmux status line
- tmux plugins/extensions
- `tmux attach` from terminal (use dashboard)

## Troubleshooting

### Sessions not appearing in dashboard

**Cause**: Old tmux sessions are not auto-discovered.

**Solution**: Create new sessions via dashboard or API.

### Engine fails to start

**Symptom**: `dtach binary not found`

**Solution**:
```bash
# Verify dtach exists
ls services/session-engine/dist/bin/dtach

# Rebuild if missing
npm run build:dtach
```

### Scrollback history lost

**Cause**: Scrollback is now per-session in `~/.aimaestro/scrollback/`

**Solution**: Old tmux scrollback is not migrated. Start with fresh sessions.

### Permission errors on sockets

**Symptom**: `Permission denied: ~/.aimaestro/sockets/`

**Solution**:
```bash
# Fix ownership
chown -R $USER ~/.aimaestro

# Fix permissions
chmod 700 ~/.aimaestro/sockets
chmod 600 ~/.aimaestro/sockets/*.sock
```

## Rolling Back

If you need to revert to tmux-based AI Maestro:

```bash
cd ai-maestro
git checkout v0.7.1  # Last tmux-based release
npm install
npm run build
npm start
```

Your old tmux sessions should still be running and accessible.

## FAQ

### Can I use tmux and dtach simultaneously?

Yes. The session engine only manages sessions created via AI Maestro. Your existing tmux sessions are unaffected.

### Will my agent registry be migrated?

Yes, agent registry data (`~/.aimaestro/agent-registry.json`) is compatible between versions.

### What about messages between agents?

Agent messaging works the same way. Messages stored in `~/.aimaestro/messages/` are compatible.

### Can I export/import sessions?

Not yet. Session export/import is planned for v1.1.0.

### Does this work on Windows/WSL?

- **WSL**: ✅ Supported (Linux binary)
- **Windows native**: ⏳ Planned for v1.2.0

## Getting Help

- **Issues**: https://github.com/23blocks-OS/ai-maestro/issues
- **Discussions**: https://github.com/23blocks-OS/ai-maestro/discussions
- **Documentation**: https://github.com/23blocks-OS/ai-maestro/tree/main/docs

## Rollout Timeline

- ✅ **Phase 0** (2025-11-06): Foundation (dtach, engine skeleton)
- 🚧 **Phase 1** (2025-11-13): IPC server, integration
- ⏳ **Phase 2** (2025-11-20): Gateway integration
- ⏳ **Phase 3** (2025-11-27): API migration
- ⏳ **Phase 4** (2025-12-04): Documentation, UI updates
- ⏳ **Phase 5** (2025-12-11): Release candidate, QA

**Note**: Dates are estimates and subject to change.
