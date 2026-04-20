# Lastty

An agent-native tiled terminal built on Tauri v2. Coding agents like Claude Code and Codex run in PTY panes and push structured UI — status, tool calls, approvals, diffs — into the app through a custom OSC protocol.

Rust owns the PTY, terminal grid, and OSC parsing. React renders the panes (via xterm.js) and the overlay UI that sits on top.

## What it is

- Tiled terminal with n-ary splits, drag-to-resize, and keyboard navigation.
- First-class agents: launch Claude Code or Codex into a pane with a prompt and optional git worktree isolation.
- OSC 7770 protocol: agents emit semantic messages (`status`, `tool_call`, `approval`, `widget`, ...) that the app renders as overlays and sidebar panels.
- Worktree-centric sidebar for managing parallel agent sessions, with inline launcher and PR dialog.

See [docs/plan/mvp.plan.md](docs/plan/mvp.plan.md) for the full design.

## Install

macOS arm64 only for now.

Download the latest `Lastty.dmg` from [Releases](https://github.com/ForeverAnApple/lastty/releases), open it, and drag Lastty to Applications. The app auto-updates via the Tauri updater.

## Use

Launch the app. You get a terminal pane running your default shell.

Common shortcuts:

- `Ctrl+Shift+H` / `Ctrl+Shift+V` — split horizontal / vertical
- `Ctrl+Shift+W` — close pane
- `Ctrl+Shift+Arrow` — move focus
- `Ctrl+Shift+N` — new terminal

Agents are defined in [`agents.toml`](agents.toml). `claude` and `codex` ship by default; add more by appending `[[agent]]` blocks. Launch one from the palette, give it a prompt, and the agent's status and tool calls render alongside its pane.

## Develop

Requirements: Rust stable, Node 20+, pnpm, Xcode command line tools (macOS).

```sh
pnpm install
pnpm tauri dev
```

Useful scripts:

- `pnpm test` — frontend tests (vitest)
- `cargo test` — Rust tests (run with `-p <crate>` when possible)
- `cargo fmt --all` — required before committing Rust changes
- `pnpm bench:xterm` — xterm.js rendering benchmark

### Layout

- `src/` — React app (terminal panes, overlays, layout engine)
- `src-tauri/` — Rust core (PTY, terminal grid, event bus, Tauri commands)
- `pane-protocol/` — OSC 7770 encoder/parser, shared between app and SDKs
- `docs/plan/` — design docs for in-flight work
- `agents.toml` — built-in agent definitions

### Release

Versions are bumped in lockstep by a script:

```sh
pnpm bump-version X.Y.Z
git commit -am "feat: vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Pushing the tag triggers the release workflow: signed/notarized macOS arm64 `.dmg` plus `latest.json` for the auto-updater.

## License

See [LICENSE](LICENSE).
