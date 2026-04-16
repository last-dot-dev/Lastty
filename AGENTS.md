# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor, etc.) working in this repo.

## Project

Lastty (npm package `pane`) is a Tauri v2 desktop app — an agent-native tiled terminal. Agents run in PTY panes and push structured UI updates into the React layer via a custom OSC escape-sequence protocol. The codebase is original, not a fork of any terminal. Rust drives the PTY, terminal grid, rendering, event bus, and rule execution; React handles presentation.

## Philosophy

- **Write the simplest code that solves the problem well.** Readable first, but never sacrifice correctness or performance for cleverness.
- **Don't build for hypotheticals.** No abstractions, helpers, flags, or error paths for scenarios that can't happen. Three clear lines beat a premature abstraction.
- **Edit existing code before adding new code.** Prefer extending a module over creating a new one — until the module is doing too much, then split cleanly.
- **Delete dead code rather than preserve it.** No commented-out blocks, no unused `_vars`, no "might need later" scaffolding.

## Rust conventions

### API shape

- Avoid positional `bool` and bare `Option` parameters — `foo(false, None)` is unreadable. Prefer enums, named constructors, newtypes, or a small config struct.
- When a positional literal is genuinely unavoidable, annotate it with `/*param_name*/` matching the callee signature exactly.
- Newtypes for domain IDs (e.g. session IDs wrapping `Uuid`). Parse/validate at the boundary once; pass the typed value inward.
- Prefer private modules with an explicitly exported crate API. Default to `pub(crate)`; reach for `pub` only when something genuinely crosses the crate boundary.
- New traits get a short doc comment explaining their role and how implementers are expected to use them.

### Idioms

- Inline format args: `format!("{x}")`, not `format!("{}", x)`.
- Collapse nested `if`s; prefer method references over trivial closures (`.map(Foo::bar)` over `.map(|x| x.bar())`).
- Make `match` exhaustive. Wildcard arms (`_ =>`) hide future variants from the compiler — only use them when you genuinely mean "any other".
- Don't extract a helper function that has exactly one caller unless it materially improves readability.

### Error handling

- Use `Result` for fallible work; use `?` to propagate. Reserve `unwrap` / `expect` for invariants the type system can't express, and write a message that explains *why* it can't fail.
- Don't validate what the type system already guarantees. Validate at system boundaries (IPC, user input, external APIs) and trust the types inward.
- Don't swallow errors with a silent fallback. If recovery is meaningful, make the recovery path explicit; otherwise propagate.

### Module and file size

- Prefer adding a new module over growing a large one. When a file drifts past a few hundred lines of non-test code, that's a signal to split.
- When you extract code, move its tests and type-level docs with it — invariants should live next to the implementation that owns them.
- High-traffic orchestration modules attract unrelated changes. Resist piling features into them; route new concepts to a focused module and re-export if needed.

### Async and concurrency

- Prefer channels and message passing over shared mutable state. Where shared state is unavoidable, keep the critical section small and obvious.
- Don't hold locks across `.await` points.
- Every long-running task should have a clear shutdown story — either a cancellation token, a closed channel, or a drop handler.

## Frontend (React/TS) conventions

- Pure logic (reducers, derivations, adapters) lives in plain TS modules with co-located `*.test.ts`. React components stay thin — they render and wire events.
- Keep the IPC surface centralized; don't scatter `invoke(...)` calls across components. A renamed command should be a one-file change on each side.
- Prefer deriving state over storing it. Local component state only when it's truly local.

## Tests

- Test behavior, not implementation. A test that breaks on every refactor isn't protecting anything.
- Prefer deep-equality assertions on whole objects over field-by-field checks — better diffs, fewer holes.
- Don't mutate process env in tests. Pass dependencies in.
- For Tauri commands that take `State`, write a runtime-generic helper and call it from both the `#[tauri::command]` wrapper and the test (via `MockRuntime`). Commands that only exist as `#[tauri::command]` can't be unit-tested cleanly.
- Mocks are for boundaries you don't own (network, clock, filesystem when relevant). Don't mock your own types — construct real ones.

## Comments and docs

- Default to no comment. Names should carry the meaning.
- Write a comment only when the *why* is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific upstream bug.
- Never describe *what* the code does — the code says that. Never reference the current PR, ticket, or author ("added for X", "see issue 123") — those rot.
- Don't create new markdown docs unless the user asks. Keep knowledge in code, types, and this file.

## Commit messages

- One line only. Format: `feat: <msg>` for new functionality, `fix: <msg>` for bug fixes.
- No co-authors, no trailers, no body.
- Examples:
  - `feat: tiled pane splitting with keyboard shortcuts`
  - `feat: OSC protocol for structured UI updates from PTY`
  - `fix: glyph atlas eviction losing active cache entries`
  - `fix: renderer passthrough so webview keeps input focus`

## Before finishing a change

- Rust edits → `cargo test` (scope with `-p <crate>` when possible). Be patient with cargo; don't kill by PID — lock contention is expected.
- Frontend edits → `pnpm test`.
- If the change touches IPC, keep the Rust handler registration and the TS IPC module in sync in the same commit.
- If the change touches the OSC protocol, verify with the headless CLI harness before wiring UI.
- UI changes: actually exercise the feature in a running app when possible. Type checks and unit tests verify code, not UX.
