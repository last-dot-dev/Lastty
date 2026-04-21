# Lastty

An agent-native tiled terminal built on Tauri v2. Coding agents like Claude Code and Codex run in PTY panes and push structured UI — status, tool calls, approvals, diffs — into the app through a custom OSC protocol.

## Features

- Tiled terminal with n-ary splits, drag-to-resize, and keyboard navigation.
- First-class agents: agents live within a world they're able to modify and communicate with each other.
- Worktree-centric sidebar for managing parallel agent sessions, with inline launcher and PR dialog.

## Install

macOS only. (for now)

Download the latest `Lastty.dmg` from [Releases](https://github.com/last-dot-dev/Lastty/releases). The app auto-updates.

## Use

Launch the app. You get a terminal pane running your default shell.

Common shortcuts:

- `Ctrl+Shift+S` / `Ctrl+Shift+V` — split below / split right
- `Ctrl+Shift+W` — close pane
- `Ctrl+Shift+Arrow` — move focus
- `Ctrl+Shift+N` — new terminal
- Settings > Keyboard can enable tmux-like bindings, including `Ctrl+A |` to
  split right, `Ctrl+A -` to split below, `Ctrl+A x`, `Ctrl+A <` / `>`,
  `Ctrl+A 1..9`, and `Ctrl+H/J/K/L` focus movement.

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
