# AGENTS.md

Guidance for coding agents working in this repo.

## Project

Lastty (npm `pane`) is a Tauri v2 agent-native tiled terminal. Agents run in PTY panes and push structured UI updates into React via a custom OSC protocol. Rust drives PTY, terminal grid, rendering, event bus, rule execution; React renders.

## Philosophy

- Simplest code that solves the problem. Readable first — never at the cost of correctness or performance.
- No abstractions, flags, or error paths for scenarios that can't happen.
- Edit existing code before adding new. Split only when a module is doing too much.
- Delete dead code. No commented-out blocks, unused `_vars`, or "might need later" scaffolding.

## Rust

### API shape

- No positional `bool` or bare `Option` params. Use enums, named constructors, newtypes, or a config struct.
- Unavoidable positional literal → annotate `/*param_name*/` matching the callee signature.
- Newtypes for domain IDs (session IDs wrapping `Uuid`). Validate at the boundary; trust the type inward.
- Default to `pub(crate)`. Use `pub` only when crossing the crate boundary.
- New traits get a short doc comment explaining role and implementer contract.

### Idioms

- Inline format args: `format!("{x}")`.
- Collapse nested `if`s. Prefer method references: `.map(Foo::bar)`.
- `match` exhaustive. Wildcard `_ =>` only when you genuinely mean "any other".
- Don't extract a single-caller helper unless readability materially improves.

### Error handling

- `Result` + `?`. `unwrap`/`expect` only for type-system-unprovable invariants — with a message explaining *why* it can't fail.
- Don't re-validate what types guarantee. Validate at IPC, user input, external APIs.
- No silent fallbacks. Explicit recovery or propagate.

### Modules

- Prefer a new module over growing a large one. A file past a few hundred non-test lines is a split signal.
- Move tests and type-level docs with the code they describe.
- Don't pile features into orchestration modules. Route new concepts to a focused module.

### Async

- Channels over shared state. When shared state is unavoidable, keep critical sections small.
- Never hold locks across `.await`.
- Every long-running task needs a shutdown story: cancellation token, closed channel, or drop handler.

## Frontend (React/TS)

- Pure logic in plain TS with co-located `*.test.ts`. Components stay thin.
- Centralize the IPC surface. A renamed command is a one-file change per side.
- Derive state; don't store it. Local state only when truly local.

## Tests

- Test behavior, not implementation.
- Deep-equality on whole objects over field-by-field.
- Don't mutate process env. Pass dependencies in.
- Tauri commands taking `State` → runtime-generic helper, called from both `#[tauri::command]` and the test (via `MockRuntime`).
- Mock only boundaries you don't own (network, clock, filesystem). Construct real instances of your own types.

## Comments

- Default: no comment. Names carry meaning.
- Comment only when the *why* is non-obvious: hidden constraint, subtle invariant, workaround for an upstream bug.
- Never describe *what*. Never reference PR, ticket, or author.
- No new markdown docs unless asked.

## Plan docs

- Complex features / architectural changes → plan doc in `docs/plan/` before implementation.
- Filename: `<feature-name>.plan.md` (e.g. `agent-scaffolding.plan.md`, `pane-focus-manager.plan.md`).
- Capture design, trade-offs, implementation order, key decisions.
- Don't commit. Delete once shipped.

## Commits

- One line. `feat: <msg>` or `fix: <msg>`. No trailers, no body, no co-authors.
- Examples:
  - `feat: tiled pane splitting with keyboard shortcuts`
  - `feat: OSC protocol for structured UI updates from PTY`
  - `fix: glyph atlas eviction losing active cache entries`

## Before finishing

- Rust → `cargo test` (`-p <crate>` when possible). Don't kill cargo by PID; lock contention is expected.
- Frontend → `pnpm test`.
- IPC change → Rust handler registration and TS IPC module in the same commit.
- OSC protocol change → verify with the headless CLI harness before wiring UI.
- UI change → exercise in a running app. Tests verify code, not UX.
