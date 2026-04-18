# Archive: wgpu renderer

This branch preserves the wgpu rendering path that was removed from `main` in favor of xterm.js as the sole renderer. It is frozen at commit `9f5d21f` and is kept for potential revival (Kitty graphics, inline overlays, extreme throughput scenarios).

## What lives here

- `src-tauri/src/renderer/` — GPU renderer (atlas, rects, shaders, per-pane surfaces).
- `src-tauri/src/platform/macos.rs` — Metal subview plumbing for per-pane surfaces.
- `src-tauri/src/bin/bench_renderers.rs` — cross-renderer benchmark harness.
- `src-tauri/src/runtime_modes.rs` — xterm/wgpu/alacritty runtime switch.
- Pane-layout IPC: `update_pane_layout` in `src-tauri/src/commands.rs` and its frontend drivers in `src/TerminalWorkspace.tsx` / `src/components/TerminalViewport.tsx`.
- `font_config.rs::load_monospace_font` and `cell_metrics` (swash/fontdb glyph prep used only by wgpu).
- Design docs: `docs/plan/wgpu-renderer-optimizations.plan.md`, `docs/plan/wgpu-per-pane-rects.plan.md`, `docs/plan/phase1-native-terminal.plan.md`.

## Reviving

Rebasing this branch onto current `main` will conflict primarily in:

- `src-tauri/src/main.rs` — bootstrap diverged when the wgpu init and `RenderCoordinator::wait_for_next` loop were removed. Re-add the GPU bootstrap alongside the xterm early-return; resolve by layering wgpu behind a runtime mode check.
- `src-tauri/src/commands.rs` — pane lifecycle (`create_pane`/`move_pane`/`remove_pane`/`update_pane_layout` + their `run_on_main` helpers) was deleted. The session/PTY command shape on `main` has likely drifted; re-port these against current session types.
- `src-tauri/Cargo.toml` — restore `wgpu`, `swash`, `etagere`, `raw-window-handle`, `bytemuck`, `pollster`, `fontdb`, and the macOS `objc2*` stack.
- Frontend — restore pane-rect tracking in `TerminalViewport`, layout flush in `TerminalWorkspace`, and the `updatePaneLayout` IPC in `src/lib/ipc.ts`.

Expect the terminal session/IPC shape to have evolved on `main`; plan to re-port the renderer against current types rather than doing a straight rebase.
