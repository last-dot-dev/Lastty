# Renderer Modes And Benchmark Plan

## Goal

Make the terminal in `lastty` performant on macOS while preserving the ability to build surrounding product UI in the web stack.

The immediate objective is not to pick one renderer by opinion. It is to support multiple renderer modes behind explicit switches, benchmark them in a repeatable way, and compare them on real workloads.

## Current Findings

- The original custom Rust renderer was bottlenecked primarily in line rebuild / text shaping work, not PTY parsing and not GPU presentation.
- Running the custom renderer in `release` is materially faster than `dev`, so all meaningful performance comparisons must use optimized builds.
- The in-Tauri `xterm.js` benchmark path is already much faster than the current custom glyph renderer on synthetic full-redraw workloads.
- `aiterm` uses a pragmatic architecture:
  - terminal state in Rust via `alacritty_terminal`
  - viewport serialized to ANSI in Rust
  - rendering delegated to `xterm.js` with `WebglAddon`
- Alacritty’s native renderer appears portable in principle because Tauri exposes native window/display handles, but the Alacritty renderer is tightly coupled to its own display/content/damage/window stack.

## Renderer Modes

Renderer modes should be explicit runtime selections, not hidden compile-time experiments.

Recommended env var:

```bash
LASTTY_RENDERER=<mode>
```

### 1. `wgpu`

Description:
- The current custom Rust renderer path.
- Rust owns terminal state, layout preparation, and GPU drawing.

Purpose:
- Baseline for existing implementation.
- Useful as the control group for benchmarks.

Current state:
- Implemented.

Known weaknesses:
- Expensive line rebuild and shaping path.
- Owns too much terminal rendering complexity for current performance level.

### 2. `xterm`

Description:
- Rust owns terminal state via `alacritty_terminal`.
- Rust serializes the visible viewport into ANSI frames.
- Frontend renders those frames using `xterm.js`.

Variants:
- xterm default renderer
- xterm with `WebglAddon`

Purpose:
- Most practical path for a high-performance terminal while keeping app UI in the web stack.

Current state:
- Real alternate path implemented as a mode.
- In-Tauri benchmark harness implemented.

Known gaps:
- Needs production-hardening as a daily-driver mode.
- Needs input/resize/selection/scrollback parity review against current path.

### 3. `alacritty_spike`

Description:
- Native GL renderer path using transplanted pieces of Alacritty’s renderer stack.
- Rust owns terminal state and native rendering.

Purpose:
- Measure whether an Alacritty-derived native renderer is worth the porting cost.

Current state:
- Not implemented.
- Feasibility partially confirmed:
  - Tauri `WebviewWindow` exposes native window/display handles.
  - Alacritty renderer dependencies identified.

Known risks:
- Coupled to Alacritty display/content/damage/window assumptions.
- Much larger integration and maintenance cost than `xterm`.

### 4. `ansi_only_bench`

Description:
- Not a user-facing renderer.
- Benchmark or diagnostic mode for measuring Rust-side ANSI frame generation cost without frontend renderer cost.

Purpose:
- Separate backend serialization cost from frontend rendering cost.

Current state:
- Rust-side ANSI builder benchmark exists conceptually and partially in benchmark code.
- This should remain a benchmark lane, not a product renderer mode.

## Benchmarking Strategy

We need three categories of benchmarks.

### A. Rust Microbenchmarks

Purpose:
- Compare Rust-side renderer strategies without any GUI noise.

Current tool:
- `bench_renderers` binary

What it measures:
- synthetic redraw workloads
- mean time for:
  - current glyph renderer strategies
  - ANSI frame builder path

Current command:

```bash
pnpm bench:renderers
```

Artifacts:
- `/tmp/lastty-renderer-bench.json`

Needed improvements:
- add more workloads:
  - scroll-like workloads
  - incremental append workloads
  - large Unicode/emoji workloads
  - mixed style churn
- add line-count and viewport-size parameterization

### B. In-Tauri Frontend Benchmarks

Purpose:
- Compare frontend terminal rendering paths inside the actual Tauri app.

Current tool:
- `xterm` benchmark mode implemented in-app

What it measures:
- replay of ANSI viewport frames through:
  - `xterm` default
  - `xterm + WebglAddon`

Current runner:

```bash
./scripts/run-xterm-bench.sh /tmp/lastty-xterm-bench.json
```

Artifacts:
- `/tmp/lastty-xterm-bench.json`

Needed improvements:
- add frame latency percentile stats, not only average write time
- add incremental workloads, not just full redraws
- add warmup runs
- add window size parameterization
- add benchmark output summarizer script

### C. Real App Trace Benchmarks

Purpose:
- Measure end-to-end behavior while interacting with the actual app and PTY.

Current tool:
- perf HUD
- `/tmp/lastty-perf.jsonl`

What it measures today:
- snapshot time
- render time
- cache update time
- rect build time
- text prepare time
- GPU time
- FPS
- changed lines
- cached lines
- pending updates

Needed improvements:
- add release-only runbook
- add scripts to reset trace files before a run
- add named workload runs:
  - `ls`
  - `find`
  - `git diff`
  - `cargo build`
  - long streaming logs

## Workloads To Standardize

These should be used across all benchmark lanes whenever possible.

### Simple

- `ls`
- `printf '%*s\n' ...` style repeated rows
- one-line prompt updates

### Incremental

- append one line per frame
- append many lines per burst
- cursor-only changes

### Heavy full redraw

- colored diff output
- dense logs with timestamps + levels
- Unicode-heavy screen contents
- wide chars / emoji / combining marks

### Real-ish

- `git diff --color=always`
- `rg --color=always`
- compiler/test output
- scrolling through long history

## Implementation Sequence

### Phase 1: Stabilize Existing Modes

1. Keep `wgpu` mode working.
2. Keep `xterm` mode working.
3. Make runtime mode selection explicit and documented.
4. Add launch scripts for each mode.

### Phase 2: Improve Benchmarks

1. Expand Rust microbenchmarks.
2. Expand in-Tauri `xterm` benchmark workloads.
3. Add a JSON summarizer for `/tmp/lastty-xterm-bench.json`.
4. Add a script for comparing benchmark result files.

### Phase 3: Harden `xterm` Mode

1. Verify input parity:
   - printable text
   - arrows/home/end
   - modifiers
2. Verify resize behavior.
3. Verify scrollback behavior.
4. Verify cursor visibility and alternate screen.
5. Verify Unicode correctness.
6. Verify selection semantics.

### Phase 4: Alacritty Native Spike

1. Add native GL context bootstrap using Tauri window handles.
2. Vendor/minimally port Alacritty renderer dependencies.
3. Build `RenderableCell` adapter from `lastty` terminal state.
4. Draw text + backgrounds only.
5. Measure against `xterm` and `wgpu`.

Success criterion:
- demonstrate materially better real performance than `xterm` or current `wgpu`
- otherwise stop the port

## Decision Criteria

We should not choose the final renderer by aesthetics. We should choose based on:

- release-mode performance on real workloads
- integration cost
- correctness risk
- maintenance cost
- fit with web-stack surrounding UI

### If `xterm` Mode Is Fast Enough

Choose `xterm` as the main renderer and stop investing in custom glyph rendering.

### If `xterm` Is Not Fast Enough But Native Port Is Clearly Better

Continue `alacritty_spike` into a real native path.

### If Neither Wins Cleanly

Revisit architecture and scope rather than endlessly tuning the current custom renderer.

## Commands

### Existing

```bash
pnpm bench:renderers
pnpm bench:trace
./scripts/run-xterm-bench.sh /tmp/lastty-xterm-bench.json
LASTTY_RENDERER=xterm cargo run -p lastty --release --bin lastty
```

### Planned

```bash
LASTTY_RENDERER=wgpu cargo run -p lastty --release --bin lastty
LASTTY_RENDERER=alacritty_spike cargo run -p lastty --release --bin lastty
node ./scripts/summarize-xterm-bench.mjs /tmp/lastty-xterm-bench.json
node ./scripts/compare-bench-results.mjs fileA.json fileB.json
```

## Immediate Next Steps

1. Add benchmark result summarizer for `/tmp/lastty-xterm-bench.json`.
2. Add more realistic incremental/append workloads to the xterm benchmark.
3. Exercise `LASTTY_RENDERER=xterm` as a real app mode on actual workloads.
4. Only after that, start `alacritty_spike`.
