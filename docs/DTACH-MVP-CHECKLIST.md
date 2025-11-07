# AI Maestro dtach MVP Completion Plan & Checklists

Version: 1.0
Status: Active
Owner: Core Maintainers

This document defines the methodical, hand-off-ready plan to complete the dtach MVP. Each high‑value task is grouped by context and expressed as Review → Plan → Implement checklists that a coding agent can execute reliably.

---

## Stage Goals

- Stabilize dtach-based sessions, restore reliable terminal scroll and clipboard, and fully re-enable the file-based agent messaging system (UI + API + CLI).
- Ensure services start/stop robustly; UI gracefully handles errors; documentation and scripts reflect dtach-first architecture.

### Definition of Done

- All checklists under Terminal UI, Messaging, Installer/CLI, Engine/Gateway, Observability, and Docs completed.
- Manual validation passes: scrolling, copy/paste, message send/read/archive/delete/forward, reconnect overlay, gateway activity, installer on dtach-only host.

### Execution Order

1) Engine & Gateway foundations → 2) Terminal UI input/scroll → 3) Messaging API/UI/CLI → 4) Installer/Docs → 5) Observability/tests.

---

## Phase 1 — Engine & Gateway Foundations

Stabilize runtime services, IPC, and connection lifecycles so UI and messaging work against a reliable base.

### 1.1 Engine Build & Paths

- [x] Review — dtach path resolution and data dirs (`services/session-engine/src/main.rs`, `engine.rs`).
- [x] Plan — Confirm env overrides: `AIMAESTRO_DTACH_PATH`, `AIMAESTRO_DATA_DIR`, IPC socket detection. Define error messages for missing/invalid dtach.
- [x] Implement — Improve candidate search, actionable errors, and docs references. Validate `npm run build:dtach` in CI.

### 1.2 Gateway Error UX & Reconnect

- [x] Review — Connection phases, backoff, and overlay states (`hooks/useWebSocket.ts`, `components/TerminalView.tsx`).
- [x] Plan — Add a visible “Reconnect” action; bubble error hints (token/origin/engine down). Limit retry loops.
- [x] Implement — Expose `reconnect()` in overlay; map common gateway errors to user hints.

### 1.3 History Replay & Backpressure

- [x] Review — Ring buffer sizing, replay queue, chunk sizes, thresholds (`SessionManager.ts`).
- [x] Plan — Validate defaults for 3–4 concurrent clients; decide trimming policy and logging.
- [x] Implement — Adjust sizes/timeouts if needed; add concise metrics and logs for trimming and queue length.

### 1.4 Optional: Persisted Scrollback Beyond Ring

- [ ] Review — Engine `capture_output`/`get_scrollback` (`engine.rs`).
- [ ] Plan — Design gateway→engine piping of live chunks; gate by config; cap retention.
- [ ] Implement — Forward live output to engine; seed history on join; document limits.

### 1.5 Optional: Real‑Time Notifications Replacement

- [ ] Review — Archived `send-tmux-message.sh` behavior.
- [ ] Plan — Define a gateway “notify” control message and minimal client banner overlay; CLI wrapper.
- [ ] Implement — Add server broadcast, client overlay, and `send-aimaestro-notify.sh`.

Acceptance for Phase 1

- [ ] Engine starts, resolves dtach path, and exposes IPC socket.
- [ ] Gateway upgrades WebSocket, serves `/activity`, and handles controlled reconnects with actionable overlays.
- [ ] History replay is fast and predictable under multiple clients with clear metrics.

---

## Phase 2 — Terminal UI & Input

Deliver smooth scrolling, reliable anchor behavior, and robust clipboard/interrupt handling.

### 2.1 Scroll Reliability (wheel/keyboard/touch)

- [x] Review — Wheel/touch/keyboard handlers and page scroll bleed (`components/TerminalView.tsx`).
- [x] Plan — Standardize delta→line mapping; ensure `capture: true` + `passive: false`; define anchor rules and visibility of “Scroll to bottom”.
- [x] Implement — Normalize wheel deltas; preventDefault/stopPropagation; verify Shift+PageUp/Down, Home/End; disable page scroll when cursor is over terminal.

### 2.2 Persisted Anchor & “Scroll to Bottom”

- [x] Review — localStorage restore and anchor logic (`components/TerminalView.tsx`).
- [x] Plan — Define restore rules when off-bottom; ensure auto-scroll only at buffer bottom; provide “jump to bottom”.
- [x] Implement — Fix viewport jumps; hide badge at bottom; test tab switches and reloads.

### 2.3 Remote Scroll Visualization (dtach)

- [x] Review — Any UI tied to server `scroll-status` events.
- [x] Plan — Gate overlays behind presence of metrics; dtach defaults to xterm-only scroll.
- [x] Implement — Hide/simplify visualizations when metrics never arrive.

### 2.4 Clipboard & Signals (Ctrl/Cmd+C/V)

- [x] Review — ClipboardAddon use, key intercepts, paste sink, OSC 52 settings.
- [x] Plan — Enforce behavior: selection → copy; no selection → send SIGINT; bracketed paste with CR/LF and ESC sanitization.
- [x] Implement — Keep ClipboardAddon; refine keydown logic; confirm OSC 52; improve sink focus/blur; add visible Copy button when selection exists.

### 2.5 Initialization/Fit Stability

- [x] Review — Precomputed cols/rows, font load, resize observer behavior (`hooks/useTerminal.ts`).
- [x] Plan — Ensure `document.fonts.ready` before measure; debounce fit; handle initial mismatch by forced resize.
- [x] Implement — Validate first paint stability; avoid micro‑oscillation; enforce resize on mismatch.

Acceptance for Phase 2

- [ ] Wheel/touch/keyboard scrolling never scrolls the page; anchor state behaves consistently.
- [ ] Ctrl/Cmd‑C copies when selection exists; sends ^C otherwise. Ctrl/Cmd‑V pastes via bracketed paste (vim tested).
- [ ] First initialization has stable size with no visual thrash.

---

## Phase 3 — Messaging System (API + UI)

Restore and harden the file‑based agent messaging experience end‑to‑end.

### 3.1 Storage & API Correctness

- [x] Review — Message schema and file ops (`lib/messageQueue.ts`) and routes (`app/api/messages/*`).
- [x] Plan — Finalize validation/errors; forward semantics; size limits; idempotence expectations.
- [x] Implement — Tighten validation/response codes; ensure sorting; add tests for send/list/get/patch/delete/forward.

### 3.2 MessageCenter UX

- [x] Review — Inbox/sent lists, unread/sent counts, read/archive/delete/forward flows.
- [x] Plan — Add success toasts; immediate count refresh on actions; explicit “Refresh”; robust empty/error states.
- [x] Implement — Wire notifications; refetch on actions; improve forwarding compose prefill/validations.

### 3.3 Unread Count Strategy

- [x] Review — Polling in page and center (10s interval) and duplication risks.
- [x] Plan — Keep polling for MVP; add manual refresh; consider SSE/WS in Phase 2.
- [x] Implement — Debounce overlapping polls; standardize error logs with user hint.

### 3.4 LLM-Friendly Copy

- [x] Review — Markdown formatting for copy‑for‑LLM.
- [x] Plan — Normalize timestamps, forwarded metadata, and null guards.
- [x] Implement — Ensure copy success feedback and consistent formatting.

Acceptance for Phase 3

- [ ] Messages store in `~/.aimaestro/messages/{inbox,sent,archived}` with correct metadata.
- [ ] UI supports send/read/archive/delete/forward with updated counts and user feedback.

---

## Phase 4 — Installer & CLI Scripts (dtach‑first)

Make messaging tooling work on dtach‑only systems and improve user guidance.

### 4.1 Remove tmux Requirement

- [x] Review — tmux prerequisite in `install-messaging.sh`.
- [x] Plan — Make tmux optional; keep warnings; Claude Code skill optional.
- [x] Implement — Adjust prerequisite checks and messaging; verify on Linux/macOS.

### 4.2 CLI Robustness

- [x] Review — Usage of `AIMAESTRO_SESSION`, `AIMAESTRO_API_URL`, and error handling in scripts.
- [x] Plan — Add `--session` and clean errors when env absent; offer jq‑less path for counts.
- [x] Implement — Extend flags, improve messages, and include minimal counts script or mode.

### 4.3 “Check on Attach/Start” Guidance

- [x] Review — Legacy tmux hooks in archive; identify dtach‑agnostic approach.
- [x] Plan — Provide zsh/bash rc snippet to check inbox on shell start.
- [x] Implement — Update docs; installer prints optional rc snippet post‑install.

Acceptance for Phase 4

- [ ] Installer succeeds without tmux; CLI scripts function using `AIMAESTRO_SESSION` from engine.
- [ ] Clear guidance for auto‑checking inbox on login.

---

## Phase 5 — Observability & Telemetry

Expose actionable metrics and helpful diagnostics.

### 5.1 Gateway Metrics & Activity

- [x] Review — `/metrics` and `/activity` endpoints.
- [x] Plan — Add counters/gauges: active sessions, bytes, replay queue, backpressure; document bearer token.
- [x] Implement — Extend metrics; add quick curl checks; tune UI activity timeout.

### 5.2 Logging & Hints

- [x] Review — Server error emits and UI overlay messages.
- [x] Plan — Map common failure modes (engine down, origin invalid, token invalid) to user‑visible hints.
- [x] Implement — Improve messages; link to TROUBLESHOOTING.

Acceptance for Phase 5

- [x] Metrics endpoints verified; UI activity badges reflect real session activity.
- [x] Users receive concrete recovery guidance on common failures.

---

## Phase 6 — Sessions/Agents & Docs/Developer Experience

Clarify dtach limitations and streamline build/run flows.

### 6.1 Sessions/Agents Limits (dtach)

- [ ] Review — Rename/windows affordances and APIs.
- [ ] Plan — Remove/disable rename/windows UI; add tooltips about dtach limits.
- [ ] Implement — Update UI and docs accordingly.

### 6.2 Quickstart & Configuration

- [ ] Review — `README`, `.env.example`, migration docs.
- [ ] Plan — One‑command build/run; port/token/IPC/data dir references; session creation tips.
- [ ] Implement — Update docs with step‑by‑step recipes and troubleshooting.

### 6.3 Messaging Guide

- [x] Review — Existing messaging docs and installer notes.
- [x] Plan — Update for dtach‑first workflows; env usage; shell rc snippet.
- [x] Implement — Edit `docs/*` and `messaging_scripts/README.md`.

Acceptance for Phase 6

- [ ] Docs accurately describe dtach architecture, limitations, and workflows.
- [ ] New contributors can build, run, and validate in minutes.

---

## QA & Validation Plan

### Browser Matrix

- [ ] Chrome/Edge/Firefox/Safari on macOS/Linux: copy/paste, bracketed paste (vim), wheel/touch/keys, anchor persistence, WebGL fallback.

### Messaging Flow

- [ ] E2E: send→inbox→read/archive/delete/forward in UI and CLI; counts update correctly; files in `~/.aimaestro/messages/...` present.

### Load & Resilience

- [ ] 3–4 concurrent clients attach; history replay and leader assignment stable; gateway restarts recover; engine unreachable shows clear overlay.

---

## Risks & Rollback

- dtach path resolution failures → Provide clear errors and build instructions.
- Clipboard restrictions in some browsers → Maintain paste sink fallback; document permissions.
- Rollback → Keep a stable tag/branch pre‑changes; feature‑flag optional additions.

---

## Hand‑Off Notes (for Coding Agent)

Suggested order of work:

1) Phase 4.1 + 2.3 — Fix installer tmux requirement and gate remote scroll overlays.
2) Phase 2.4 + 2.1 — Clipboard polish and scroll capture/anchor behavior.
3) Phase 3 — Harden MessageCenter flows and API validation; update docs.
4) Phase 1 — Engine/Gateway polishing; reconnect UX.
5) Phase 5 — Metrics/logging; Phase 6 — Docs/quickstart cleanups.
