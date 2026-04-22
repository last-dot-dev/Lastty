# Benchmarking strategy

We bench to catch perf regressions on the hot path between a PTY producing bytes and xterm.js painting them. The goal isn't to chase peak numbers — it's to notice when a change moves p95 the wrong way, and to have a history to diff against.

## Harnesses

| Harness | Command | Scope |
|---|---|---|
| stress | `pnpm bench:stress` | End-to-end: packaged app boots, drives 6 panes with synthetic scenarios for 30s, writes `/tmp/lastty-stress.json`. Primary regression check. |
| pipeline | `./scripts/run-pipeline-bench.sh` | Isolated Rust pipeline under `bench-harness/` crate. Hits render → emit without IPC or frontend. Useful when stress numbers move and you need to localize the cause. |
| renderers | `pnpm bench:renderers` | Micro-bench of `render_full` / `render_partial` on a canned grid. Cheapest, earliest signal during Rust-only work. |
| xterm | `pnpm bench:xterm` | Frontend-only write latency against xterm.js with canned payloads. Use when a change touches ANSI encoding or the frontend write path. |

Stress is the one that gets logged to `history.md`. The others are drill-downs.

## Metrics glossary

Stress bench reports these per-session and as aggregates.

- `render_us` — time spent inside `render_viewport` (Rust). Grid walk + SGR emission. Moves when the render code changes or when damage grows.
- `emit_us` — time to fire the `term:frame` Tauri event. Moves with payload size and IPC serialization.
- `mark_to_emit_us` (**m2e**) — wall time from the coordinator being woken (session marked dirty) to the emit firing. End-to-end backend latency. Moves with rate-cap policy, coalescing, and everything upstream.
- `frontend_write_ms` — xterm.js `terminal.write(bytes, cb)` callback latency on the renderer. Moves with payload size, base64 decode cost, and xterm.js work.
- `ansi_bytes` — frame payload size. Directly drives emit + frontend write.
- `coalesce` — emits / marks. < 1.0 means we're dropping/merging marks (good when under load). ~1.0 means we paint every mark.

We care primarily about **p95**, not averages. Averages hide the long tail that actually matters for keystroke feel and spinner jitter.

## Scenarios

Each stress pane runs one scenario for the bench duration:

- `streaming-text` — LLM-style token stream, small per-tick writes. Mirrors the common case.
- `color-cycle` — SGR-heavy: cell colors change every tick. Stresses the render path and ANSI size.
- `fade` — full-viewport repaint every tick. Maximum damage, largest frames.
- `spinner-log` — spinner glyph overwriting in place alongside log lines. Adversarial for dedup/coalesce.
- `alt-screen-redraw` — TUI-style alt-screen toggles and full redraws. Catches alt-screen regressions.
- `tool-burst` — idle punctuated by large bursts. Mirrors a tool call returning a wall of output.

If a metric regresses, check which scenario moved first — it narrows the cause quickly (e.g. `color-cycle` moving alone points at SGR emission; `fade` alone points at full-frame size).

## Rough budgets

Targets below are informal guardrails — not hard SLAs. If any stress-aggregate p95 drifts above these on an otherwise-unrelated change, investigate before landing.

- `mark_to_emit_us` p95 < 5 ms
- `frontend_write_ms` p95 < 3 ms
- `render_us` p95 < 500 µs
- `emit_us` p95 < 150 µs

Current numbers live in `history.md`. Hotspot scenarios (`fade`, `spinner-log`) can run 1.5–2x aggregate p95 and that's fine.

## When to bench

- Before and after any change under `src-tauri/src/terminal/`, `src-tauri/src/render_sync.rs`, the frontend write path (`TerminalHostRegistry`, `xtermFrame`), or the IPC payload shape.
- Not needed for UI-only changes, new commands, or pure refactors that don't touch the hot path.
- Always log the *after* run to `history.md` if numbers moved meaningfully (>10% on any p95).

## Interpreting a run

The summarizer prints a per-session table and a hotspot ranking. Read it in this order:

1. **Aggregate line** — quick yes/no on overall health.
2. **Per-scenario `m2e p95`** — which workload is hot?
3. **Hotspot ranking** — the wall-ms column factors in volume, so a scenario with moderate p95 but many emits can dominate.
4. **`render p95` vs `emit p95` vs `write p95`** — isolates the bottleneck to render-stage, IPC-stage, or frontend-stage.

If all three stages rose together, suspect payload size (`ansi_bytes`). If only one stage rose, the fix lives in that stage.
