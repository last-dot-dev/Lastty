# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Lastty (npm package name `pane`) is a Tauri v2 desktop app for an agent-native tiled terminal. Agents run in PTY panes and push structured UI updates into the React layer via a custom OSC 7770 escape sequence protocol (see [pane-protocol/src/lib.rs](pane-protocol/src/lib.rs)). Not a fork of any terminal — the codebase is original. Background and staged roadmap live in [plans/MVP.md](plans/MVP.md) and [plans/MVP_STAGES.md](plans/MVP_STAGES.md).

## Common commands

All `pnpm`/`cargo` commands assume you are inside `nix develop` (see [flake.nix](flake.nix)) or have the Rust toolchain + Node/pnpm available globally.

- `pnpm dev` — vite dev server only (port 1420; not the app)
- `pnpm tauri dev` — full app (Tauri shell + vite)
- `pnpm build` — `tsc && vite build` (runs automatically before `tauri build`)
- `pnpm test` — frontend vitest run (jsdom). Single file: `pnpm test -- src/app/layout.test.ts`
- `cargo test` — Rust tests for the workspace (`pane-protocol` + `lastty`)
- `cargo test -p lastty --bin pane_cli` — tests for the PTY validation binary
- `cargo run -p lastty --bin pane_cli -- --dump-json /tmp/out.json -- <cmd>` — headless OSC protocol harness
- `pnpm bench:renderers` — wgpu/glyphon renderer benchmark (writes `/tmp/lastty-renderer-bench.json`)
- `pnpm bench:xterm` — launches Tauri in benchmark mode (`LASTTY_BENCH_MODE=xterm`), writes `/tmp/lastty-xterm-bench.json`. Summaries via `pnpm bench:xterm:summary`, failure-path check via `pnpm bench:xterm:verify-failure`.
- `pnpm bench:trace` — digest `/tmp/lastty-perf.jsonl` (the live perf trace written by the render loop in [src-tauri/src/main.rs](src-tauri/src/main.rs))

## Runtime modes (env vars)

Resolved in [src-tauri/src/runtime_modes.rs](src-tauri/src/runtime_modes.rs) and surfaced to the frontend via the `get_renderer_mode` / `get_benchmark_mode` / `get_benchmark_config` IPC commands.

- `LASTTY_RENDERER` — `xterm` (default), `wgpu`, or `alacritty_spike` (falls back to xterm; unimplemented). This chooses whether the frontend renders via xterm.js (driven by `term:frame` events) or whether Rust drives a wgpu/glyphon renderer.
- `LASTTY_BENCH_MODE=xterm` — boots the Tauri app in the [XtermBench](src/XtermBench.tsx) harness instead of the normal UI, then exits after writing results.
- `LASTTY_BENCH_{COLS,ROWS,ITERATIONS,WARMUP,OUTPUT,FORCE_FAILURE}` — benchmark configuration consumed through `BenchmarkConfig`.
- `LASTTY_RECORDINGS_DIR` isn't currently wired; recordings are written to `.lastty-recordings/` under the workspace root (ignored by git).

## Architecture

### Cargo workspace

Two Rust crates, defined in [Cargo.toml](Cargo.toml):

- **[pane-protocol/](pane-protocol/)** — zero-dep crate implementing the OSC 7770 envelope (`\x1b]7770;{json}\x07` / ST) and a byte-stream state machine ([parser.rs](pane-protocol/src/parser.rs)) that splits an incoming PTY byte stream into interleaved `ParsedChunk::Terminal(bytes)` and `ParsedChunk::Message(AgentUiMessage)`. Shared by the host app and any agent-side SDK. `AgentUiMessage` variants ([message.rs](pane-protocol/src/message.rs)) are semantic (Status/Progress/ToolCall/FileEdit/Approval/...), not component-based — agents send data, the app decides presentation.
- **[src-tauri/](src-tauri/)** — the `lastty` binary crate. Also ships two auxiliary binaries: [bench_renderers](src-tauri/src/bin/bench_renderers.rs) (wgpu/glyphon micro-bench) and [pane_cli](src-tauri/src/bin/pane_cli.rs) (standalone ratatui TUI that spawns a child PTY and renders OSC 7770 messages in a sidebar — the validation harness from Stage 0).

### Rust host layout

[src-tauri/src/main.rs](src-tauri/src/main.rs) wires everything together inside `tauri::Builder::setup`:

1. Resolves renderer + benchmark modes.
2. In `xterm`/`alacritty_spike` mode, spawns [`terminal::render::spawn_frame_emitter`](src-tauri/src/terminal/render.rs) which converts dirty-generation wakeups into `term:frame` events for the frontend and returns early.
3. In `wgpu` mode, creates a [`TerminalRenderer`](src-tauri/src/renderer/mod.rs) against the main webview window and runs a dedicated render thread that snapshots alacritty's `Term`, renders through glyphon + a custom rect pipeline ([shader.wgsl](src-tauri/src/renderer/shader.wgsl)), and emits `perf:stats` events + JSONL trace every 250 ms.

Core managed state:

- **[`TerminalManager`](src-tauri/src/terminal/manager.rs)** — `DashMap<SessionId, TerminalSession>`. Each [`TerminalSession`](src-tauri/src/terminal/session.rs) owns an `alacritty_terminal::Term` behind a `FairMutex`, a PTY via `alacritty_terminal::tty`, its `EventLoop` channel, an `OscParser`, and plumbs all PTY output through both the OSC parser (which emits `AgentUiEvent`s) and the terminal grid. Render wakeups go through the shared [`RenderCoordinator`](src-tauri/src/render_sync.rs) (generation counter + condvar) so the render loop wakes only when some session is dirty.
- **[`EventBus`](src-tauri/src/bus.rs)** — publishes `BusEvent`s on a `tokio::sync::broadcast` channel, appends every event as a JSONL recording under `recordings_dir/<session_id>.jsonl` (read via `list_recordings`/`read_recording`), and runs the **rule executor**: a background task that consumes bus events and launches agents when declared rule triggers fire.

### Agents and rules

- [agents.toml](agents.toml) at the workspace root declares runnable agents (`id`, `command`, `default_args`, `prompt_transport`: `argv` | `stdin` | custom). Loaded by [`agents::load_agent_registry`](src-tauri/src/agents.rs). Launched via the `launch_agent` Tauri command, which can create the session inside a git worktree (`isolate_in_worktree: true`).
- Rules in the same file attach `RuleTrigger { event, filter }` → `RuleAction { launch_agent, prompt, ... }`. The executor debounces via `debounce_ms` and publishes `BusEvent::RuleTriggered` when it auto-launches an agent.

### Frontend layout

Frontend entrypoint [src/main.tsx](src/main.tsx) branches on runtime mode: `XtermBench` for benchmark mode, `XtermTerminal` (which just re-exports [`TerminalWorkspace`](src/TerminalWorkspace.tsx)) for the default xterm path, and [`App`](src/App.tsx) (wgpu passthrough shell) otherwise. Pure modules in [src/app/](src/app/) (layout tree, session restore, agent UI reducer, rules summary, xterm frame/selection adapters) each have a sibling `*.test.ts` and are the right place for unit-testable logic. Tauri IPC surface is centralized in [src/lib/ipc.ts](src/lib/ipc.ts) — keep it in sync with the `invoke_handler` list at the bottom of [main.rs](src-tauri/src/main.rs) when adding commands.

## Conventions worth knowing

- Tauri commands that take `State` don't mock well — write runtime-generic helpers (`fn foo_for_runtime<R: Runtime>(...)`) and call them both from the `#[tauri::command]` wrapper and from tests using `tauri::test::mock_app` / `MockRuntime`. Examples in [commands.rs](src-tauri/src/commands.rs).
- `SessionId` is a newtype around `Uuid`; always go through `SessionId::parse` at IPC boundaries.
- The window is intentionally transparent with a macOS transparent title bar (`macos-private-api` Tauri feature). Background color is set explicitly in `setup`.
- `/tmp/lastty-perf.jsonl` is appended to across runs — benchmark scripts `rm -f` their output first; do the same if you add new trace artifacts.
- `.lastty-recordings/`, `references/**`, and `docs/plan/**` are git-ignored but un-ignored in [.ignore](.ignore) so ripgrep/Claude Code can read them.
