# MVP Stage Plan

This file maps `plans/MVP.md` onto the current `lastty` repo rather than the greenfield scaffold described in that document.

## Stage 0: Validation Harness And Runtime Alignment

Status: Completed

Architecture
- Added explicit runtime-mode resolution in Rust (`src-tauri/src/runtime_modes.rs`).
- Added a PTY-first validation artifact in `src-tauri/src/bin/pane_cli.rs` so the OSC agent protocol can be exercised outside the Tauri shell.
- The app now has a single source of truth for:
  - resolved renderer mode
  - benchmark mode
  - xterm benchmark configuration

Implemented
- `xterm` is the default renderer path.
- `wgpu` remains available via `LASTTY_RENDERER=wgpu`.
- benchmark config is exposed to the frontend through typed IPC.
- `pane_cli` now spawns a real PTY, parses `pane-protocol` OSC messages, renders a ratatui split view, forwards common keyboard input to the child session, and supports `--dump-json` for headless proof artifacts.

Verification
- `cargo test -p lastty --bin pane_cli`
- `cargo run -p lastty --bin pane_cli -- --dump-json /tmp/lastty-pane-cli-validation.json -- python3 -c '…emit OSC 7770 sample…'`

## Stage 1: Single-Session Shell Cleanup

Status: Completed

Architecture
- The previous xterm path was a single monolithic component.
- It is now split into:
  - `src/components/TerminalViewport.tsx`
  - `src/TerminalWorkspace.tsx`

Implemented
- The default xterm shell now runs through the workspace surface.
- Session-specific input, resize, and frame subscriptions are isolated per terminal viewport.

## Stage 2: Pane And Layout Model

Status: Completed

Architecture
- Introduced a pure state model in `src/app/layout.ts`.
- Layout is represented as a recursive leaf/split tree.

Implemented
- create workspace
- split pane horizontally/vertically
- weighted split resize updates with clamped pane minimums
- close pane with parent collapse
- focus tracking
- keyboard shortcuts for split/close/focus cycling while the app is focused

Verification
- `src/app/layout.test.ts`
- `pnpm test -- src/app/layout.test.ts`

## Stage 3: Multi-Session Xterm Workspace

Status: Completed

Architecture
- The backend already supported multiple terminal sessions through `TerminalManager`.
- The frontend now consumes that capability directly.

Implemented
- splitting a pane creates a new terminal session
- drag handles resize split weights in the live workspace shell
- closing a pane kills its session
- keyboard focus movement follows pane geometry for arrow-key navigation
- pane titles react to `session:title`
- pane exit state reacts to `session:exit`

## Stage 4: Agent UI State Layer

Status: Completed

Architecture
- Added a pure agent UI reducer in `src/app/agentUi.ts`.
- Wired PTY output interception to `pane-protocol` parsing in the Rust session layer.
- Added per-session control sockets for app → agent approval responses.

Implemented
- typed agent UI message model
- reducer for status/progress/tool/file/approval/notification/widget events
- pane chrome consumes live reducer state from real `agent:ui` events
- approval overlay with response delivery through `PANE_CONTROL_SOCKET`
- pane-local inspector with tool calls, file changes, widgets, and notifications
- widget registry for markdown, table, and json payloads

Verification
- `src/app/agentUi.test.ts`

## Stage 5: Benchmarking And Renderer Decision Support

Status: Completed with one open issue

Implemented
- expanded Rust microbench cases and percentile output
- expanded xterm benchmark workload model and output schema
- added `scripts/summarize-xterm-bench.mjs`
- added `scripts/compare-bench-results.mjs`
- updated `scripts/run-xterm-bench.sh` to drive benchmark config via env

Open issue
- The in-app xterm benchmark launched successfully but did not write a report in unattended verification; this needs follow-up before treating that lane as fully reliable.

## Stage 6: Agent Orchestration, Event Bus, And Recording

Status: Mostly completed for MVP scope

Implemented
- agent registry loads from `agents.toml`
- launch-agent modal in the workspace shell
- argv / flag / stdin prompt transport support in backend agent launches
- optional git worktree isolation on launch
- session overview with focus, restart, kill, and recording actions
- session metadata now tracks agent id, prompt summary, control-socket status, and worktree path
- lightweight event bus publishes session lifecycle, agent semantic events, approvals, PTY input/output, and resize events
- session recordings are persisted as JSONL under `.lastty-recordings/`
- recordings can be listed, inspected, scrubbed, and replayed through a timeline-controlled terminal surface in the frontend shell
- replay snapshots now expose step-local agent status, approvals, file activity, and finished state alongside the terminal
- recent bus activity is visible in the workspace UI

Remaining gaps
- rule-driven inter-agent orchestration is not implemented yet
- replay still rebuilds the terminal by reapplying recorded PTY output rather than reconstructing a richer semantic viewport model
