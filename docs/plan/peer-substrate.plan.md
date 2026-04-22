# Peer Substrate — Agent↔App + Agent↔Agent Messaging

Branch: `feat/peer-substrate`. Replaces and supersedes the split `agent-to-app.plan.md` / `agent-to-agent.plan.md`.

## Scope

One substrate carries three flows: agent → UI state (status, progress, notifications), agent ↔ agent messaging, and agent ↔ user messaging. All three are expressed as MCP tools exposed to every spawned agent, injected at spawn time with zero user configuration.

The system is a **process tree of agents** rooted at the human user. Parents can spawn children, message any peer, and terminate their descendants. Lifecycle flows down the tree; messaging is peer-to-peer.

## Vision

Lastty is an agent-native tiled terminal where agents coordinate as peers in a tree. The hero demo: the user asks Claude Code to implement a module; Claude spawns Codex in a side-tiled pane, writes code, requests a review (blocking), applies nits, and terminates Codex. No user intervention in the middle. No files written to the user's repo. No edits to the user's global Claude or Codex settings.

## Hard requirements

### Agent → UI
1. An agent pushes **status / progress / finished / notification** state from within a tool call; the pane UI reflects it within one frame.
2. Tool calls and file edits are loggable from MCP tools for the sidebar log.
3. The push mechanism is **discoverable without user config** — MCP tools appear in Claude Code's and Codex's tool lists on spawn.
4. UI pushes never block the agent. Fire-and-forget; tool return is immediate.

### Agent ↔ Agent
5. Unified addressing: `Addr::Session(id)`, `Addr::Agent(kind)` as broadcast, `Addr::Channel(name)`, `Addr::User`.
6. Send is MCP-tool-initiated (`peer_post`, `peer_dm`, `peer_reply`, `peer_request`, `peer_spawn`, `peer_terminate`, `peer_join`, `peer_leave`, `peer_presence`).
7. Receive is **PTY stdin injection** with `[peer:<from>]` framing and a trailing newline. Primary path for interactive agents.
8. `peer_request` blocks as a tool call until its correlated `peer_reply` arrives or timeout; the reply is returned as the tool result.
9. `peer_inbox` / `peer_wait` are opt-in for listener-bot agents whose role is to park.
10. **From-identity is router-enforced**, not self-declared.
11. Delivery is **at-most-once per recipient**; dedupe windowed by correlation id (~10s).
12. In-order per-sender.
13. Channel joins receive the ring-buffer replay.
14. Self-delivery is suppressed through channel fanout.

### Tree / hierarchy
15. User is the root agent; addressed as `Addr::User`. No PTY; communicates via ChatPanel.
16. Spawn via `peer_spawn(kind, prompt)` — **no user approval prompt** (gated only by caps).
17. Spawned pane auto-tiles alongside the parent.
18. Parent can `peer_terminate` **direct children only**. User (root) can terminate any agent.
19. Parent death **cascade-kills** descendants.
20. Caps: **max 8 live agents total, max depth 4, max 4 direct children per agent**. Tool returns error on cap.

### Onboarding / coexistence
21. **Zero post-install clicks.** Install Lastty → spawn Claude Code pane → peer tools are in the tool list.
22. **Zero files in the user's project cwd.**
23. **Zero edits to user's global config** (`~/.claude.json`, `~/.codex/config.toml`, shell rc).
24. **User's existing MCP servers keep working** inside Lastty panes. Additive layering.
25. Uninstalling Lastty leaves no trace in agent configuration.

### Lifecycle
26. Agent exit clears its subscriptions, presence, pending correlations, child links.
27. Per-session tempdirs (`$TMPDIR/lastty-<sid>/`) are removed on session drop.
28. Lastty crash → startup cleanup unlinks orphaned sockets and tempdirs.

## Design

### The tree

```
Addr::User (root)
├── claude-code@a3f
│   └── codex@b1c              (spawned by claude-code for review)
└── codex@c7e
    └── linter@d2a             (spawned by codex for a specific task)
```

Each live session carries: `session_id`, `agent_id` (kind), `parent: Option<SessionId>`, `children: Vec<SessionId>`. Stored in the `PeerRouter`, not duplicated in `TerminalManager` (no second source of truth).

Lifecycle invariants enforced in the router:
- A `peer_terminate` call only succeeds if target is a direct child of the caller OR caller is root.
- A parent going down triggers cascade termination, depth-first, children before self.
- On spawn, check: `tree.total_live < 8`, `tree.depth(parent) < 4`, `tree.children(parent).len() < 4`.

### Tool surface (MCP)

Exposed by `lastty-mcp` — the stdio MCP server injected into each spawned agent.

**Send / lifecycle:**
- `peer_spawn(kind, prompt)` → `{ session_id }`
- `peer_terminate(session_id)` → `{ ok }`
- `peer_request(to, body, timeout_ms)` → reply body (blocking)
- `peer_reply(correlation_id, body)` → `{ ok }`
- `peer_dm(to, body)` → `{ ok }` (fire-and-forget)
- `peer_post(channel, body)` → `{ ok }` (fire-and-forget broadcast)
- `peer_join(channel)` / `peer_leave(channel)` → `{ ok }`
- `peer_presence(status)` → `{ ok }`

**Opt-in inbound pull:**
- `peer_inbox()` → `{ messages: [...] }` (nonblocking drain)
- `peer_wait(timeout_ms, filter?)` → `{ messages: [...] }` (blocking drain)

**UI push (emit OSC 7770 internally):**
- `ui_status(phase)` → `{ ok }`
- `ui_progress(pct, label?)` → `{ ok }`
- `ui_notify(severity, text)` → `{ ok }`
- `ui_finished(summary?)` → `{ ok }`

Tool descriptions are written for the model: explicit usage examples, framing conventions, and the pattern ("call `ui_status('thinking')` before a long step; call `ui_finished(...)` once at the end").

### Inbound delivery — stdin push

Primary path for interactive agents. The router, on `BusEvent::PeerMessage` where the target resolves to a session in push mode, formats one line and writes it to the target's PTY master:

```
[peer:<from-addr>] <body.text>\n
```

For structured bodies, bodies serialize as JSON after the bracketed prefix. The harness (Claude Code, Codex) queues the line as user input — same mechanism used for a human typing during generation. No bracketed-paste wrap (we want Enter to submit).

Flood control: coalesce pushes into batched summaries when > 5 arrive within 500ms to one target. Format:

```
[peer:channel:general — 7 new messages]
  - claude-code@a3f: done with the parser
  - codex@b1c: starting tests
  ...
```

Loop prevention: router tracks `(correlation_id → expected_responder_session)` plus a 10s dedupe table keyed by correlation id + destination. Skips self-delivery through channel fanout.

Debounce: hold pushes until PTY output has been idle ~50ms, then flush. Prevents visible interleave in the user's view of the pane.

### Inbound delivery — solicited reply

`peer_request(to, body, timeout_ms)` creates a correlation id, parks the MCP tool call, and sends a `Dm { to, body, correlation_id }`. When a `Reply { correlation_id, body }` arrives at the router with a matching owner, the tool-call result is released with the reply body. Timeout → tool-call returns `Err("peer_request timed out")`.

This is a blocking tool call. While parked, the model consumes no tokens and no compute — it is parked on the MCP client side waiting for stdio response. Cost is zero while waiting. The model cannot run other tools during the wait; that's the cost of straight-line request/response semantics.

### Inbound delivery — listener-bot pattern

For spawned agents whose job is to wait: bootstrap prompt tells them to call `peer_wait` in a loop. Same mechanism, different control-flow shape. Works for any agent harness.

### Onboarding — MCP injection per harness

At pane spawn, before exec:

1. `mkdir $TMPDIR/lastty-<sid>/`
2. Write `control.sock` (existing behavior, path already `$TMPDIR/lastty-<sid>.sock` — moves inside the dir).
3. Write MCP config for the target harness.
4. Exec the agent with injection flag.

**Claude Code** (`kind = "claude-code"` in `agents.toml`):

Write `$TMPDIR/lastty-<sid>/mcp.json`:

```json
{
  "mcpServers": {
    "lastty": {
      "command": "/path/to/Lastty.app/Contents/MacOS/lastty-mcp",
      "env": {
        "LASTTY_SESSION_ID": "<sid>",
        "PANE_CONTROL_SOCKET": "$TMPDIR/lastty-<sid>/control.sock"
      }
    }
  }
}
```

Append to spawn command: `--mcp-config $TMPDIR/lastty-<sid>/mcp.json`. No `--strict-mcp-config` — the user's own MCPs remain loaded.

**Codex** (`kind = "codex"`):

Append `-c` overrides to the spawn command (layers on top of `~/.codex/config.toml`):

```
-c 'mcp_servers.lastty.command="/path/to/lastty-mcp"'
-c 'mcp_servers.lastty.args=[]'
-c 'mcp_servers.lastty.env.LASTTY_SESSION_ID="<sid>"'
-c 'mcp_servers.lastty.env.PANE_CONTROL_SOCKET="$TMPDIR/lastty-<sid>/control.sock"'
```

No file written. User's `~/.codex/config.toml` is untouched.

**Other kinds** (`kind = "none"` or missing): no MCP injection. Agent gets `$PANE_CONTROL_SOCKET` env; anyone who wants to send a message writes to the socket directly (one line of NDJSON `PeerMessage`). `lastty-mcp` also supports one-shot CLI mode (`lastty-mcp post …`, `lastty-mcp dm …`) for scripts and naked shells — same binary, dispatched on argv.

### Child bootstrap

When `peer_spawn(kind, prompt)` fires:

1. Router verifies caps (total / depth / direct-children).
2. Allocates a new `session_id`, registers `(parent = caller, kind)` in the tree.
3. Auto-tiles a new pane alongside the caller's pane.
4. Spawns the agent with:
   - `--append-system-prompt` (Claude Code) or equivalent bootstrap note for Codex:
     ```
     You are running inside Lastty as a child of <parent_agent_id> (session <parent_sid>). Your peer tools (peer_*, ui_*) are available via MCP. See tool descriptions for usage.
     ```
   - The `prompt` argument injected as the first user message after boot (via PTY stdin after the agent signals ready — or written into a `--initial-prompt` flag where available).
   - Env: `LASTTY_SESSION_ID`, `LASTTY_AGENT_ID`, `LASTTY_PARENT_SESSION_ID`, `PANE_CONTROL_SOCKET`.
   - MCP config injected per the scheme above.
5. Returns `{ session_id }` to the caller.

### agents.toml extensions

```toml
[runtime]
max_total_agents = 8
max_depth = 4

[[agent]]
id = "claude-code"
name = "Claude Code"
command = "claude"

[agent.mcp]
kind = "claude-code"               # "claude-code" | "codex" | "none"

[agent.spawn]
can_spawn = ["codex", "aider"]     # agent kinds this one may spawn
max_children = 4                   # ceiling for this agent's subtree breadth
```

Defaults: `[agent.spawn]` absent → `can_spawn = ["*"]`, `max_children = 4`. `[agent.mcp]` absent → `kind = "none"`.

## Current state (delivered)

**Block A — Agent→App rendering (DONE)** — commit `bc814b1`

- `zustand` added; `src/app/agentStore.ts` wraps `reduceAgentMessage`; overlay/toast components extracted.
- `TerminalWorkspace` reads via selectors; no prop drilling.
- Session-exit drops state. 794 frontend tests pass.

**Block B — Peer substrate over OSC (DONE)** — commits `95e7fb6`, `05804ba`, `879cf46`, `40aca91`

- `pane-protocol/src/peer.rs`: `Addr`, `PeerMessage`, `Presence` with serde.
- `AgentUiMessage::Peer(PeerMessage)` wrapping variant.
- `BusEvent::PeerMessage`, `BusEvent::PeerPresence` with typed accessors.
- `RuleFilter` extended: `channel`, `from_agent`, `to_agent`, `presence`; template vars resolve.
- `src-tauri/src/peer/` module: `PeerRouter` with channels, ring buffer (50-msg), correlation-owner tracking with replay protection, presence map.
- Frontend `peerStore`, `ChatPanel`, `bus:event` wiring.
- `send_peer_message` Tauri command for user-as-peer sends.
- Async rule-launch fix (no more Tokio blocking-pool saturation under rule storms).

**Infrastructure already in place:**
- Unix socket per session (`$TMPDIR/lastty-<sid>.sock`) with env var `PANE_CONTROL_SOCKET`.
- `lastty-peer/` workspace crate — **to be deleted in Block C**. Its entire surface is absorbed into `lastty-mcp`'s one-shot CLI mode. Keeping it would be dead code.
- Bin-dir-on-PATH trick in `session.rs:228-239` — **to be removed in Block C**. It exists only to make `lastty-peer` discoverable; with `lastty-peer` gone and `lastty-mcp` spawned by absolute path from the MCP config, agents get a clean PATH.

## Remaining block map

| Block | Scope |
|-------|-------|
| **C** | Build `lastty-mcp` (stdio MCP + one-shot CLI modes), Tauri `externalBin` bundling, delete `lastty-peer/` and its PATH-prepend |
| **D** | Spawn-time MCP injection per harness (Claude Code, Codex) + agents.toml `[agent.mcp]` |
| **E** | Stdin push as primary inbound; replace OSC 7771 outbound for push-mode agents |
| **F** | Tree lifecycle: `peer_spawn`, `peer_terminate`, caps, cascade kill |
| **G** | `peer_request` blocking tool + `peer_reply` correlation plumbing through MCP |
| **H** | Approval fold-in; `agents.toml` permissions; socket cleanup on crash; rule filter docs |
| **V** | Validation harness: `pane-cli` peer roundtrip + MCP integration tests |

Each block is independently shippable. C is the packaging unblock. D+E+G give us the hero demo. F adds the spawn/terminate semantics the demo actually calls. H is hardening. V is the test oracle.

## Block C — Bundling

Build `lastty-mcp` as a dual-mode binary:
- Invoked with no args (or `--stdio`) → runs as a stdio MCP server. This is how Claude Code / Codex spawn it.
- Invoked with a subcommand (`post`, `dm`, `join`, `leave`, `presence`) → one-shot CLI that writes one NDJSON message to `$PANE_CONTROL_SOCKET` and exits.

Dispatch in `lastty-mcp/src/main.rs`: `match args.as_slice() { [] | ["--stdio"] => run_mcp_server(), cli_args => run_one_shot_cli(cli_args) }`.

Tauri `externalBin` configuration in `tauri.conf.json`:

```json
"bundle": {
  "externalBin": [
    "../target/release/lastty-mcp"
  ]
}
```

`release.yml` already runs `tauri-action` which builds the workspace. Explicit step to build `lastty-mcp` first, then let `tauri build` pick it up via `externalBin`.

`session.rs:228-239` — **remove** the PATH-prepend trick. It was added for `lastty-peer` discovery; with `lastty-peer` gone and `lastty-mcp` spawned directly by the MCP client using an absolute path (resolved from `current_exe().parent()` at config-materialization time), nothing needs to be on the agent's PATH.

`lastty-peer/` — **delete**. Workspace member removed from root `Cargo.toml`. The entire CLI surface moves to `lastty-mcp` one-shot mode; there is no remaining caller.

Deliverable: a packaged `.dmg` where (a) `lastty-mcp` lives inside `Lastty.app/Contents/MacOS/`, (b) spawning a Claude Code pane with `--mcp-config` pointing at the bundled server succeeds, (c) a spawned pane's PATH does **not** contain a Lastty binary directory, (d) the workspace has no `lastty-peer` crate.

## Block D — MCP injection

New module `src-tauri/src/terminal/mcp_injection.rs`:

```rust
pub(crate) fn materialize(
    session_id: &SessionId,
    kind: McpKind,
    tempdir: &Path,
    control_socket: &Path,
) -> ExtraSpawn {
    // returns:
    //   extra_args: Vec<String>   — appended to the spawn command
    //   extra_env: HashMap<String, String>
    //   files_to_clean: Vec<PathBuf>  — cleaned up on session drop
}
```

Dispatched from `session.rs` after tempdir creation. `ExtraSpawn` is consumed by the existing command-builder path. Per-kind logic writes `mcp.json` for Claude or generates `-c` overrides for Codex.

Extend `AgentDefinition` in `agents.rs` with an `[agent.mcp]` parse producing `McpKind::ClaudeCode | Codex | None`.

Tempdir layout moves from flat `lastty-<sid>.sock` to a per-session directory:

```
$TMPDIR/lastty-<sid>/
├── control.sock
├── mcp.json                (if kind = claude-code)
└── codex/ (reserved)
```

`session.rs` bind path updated. `Drop` impl recursively cleans the directory, not just the socket file.

## Block E — Stdin push as primary inbound

Replace `outbound::deliver` body: instead of OSC 7771, format `[peer:<from>] <text>\n` and write to the PTY master.

`outbound.rs`:

```rust
pub(crate) fn deliver<R>(
    manager: &TerminalManager<R>,
    session_id: &SessionId,
    message: &PeerMessage,
) {
    let Some(session) = manager.get(session_id) else { return };
    let line = format_push_line(message);
    session.write_stdin(line.as_bytes());  // PTY master write
}
```

Framing module `src-tauri/src/peer/framing.rs`:
- `format_push_line(&PeerMessage) -> String`
- Respects flood-control batching (router-level debounce queue keyed by target session).
- Skips self-delivery.

Keep OSC 7771 encoding in `pane-protocol` for now — it's dead code in the default (push-mode) path but kept as a fallback for listener-bot agents that prefer structured inbound. Revisit deletion after Block F if no caller remains.

## Block F — Tree lifecycle

Extend `PeerRouter` with:

```rust
struct Tree {
    nodes: DashMap<String, TreeNode>,       // sid → node
    root_children: Mutex<Vec<String>>,      // user's direct children
}

struct TreeNode {
    session_id: String,
    agent_id: String,
    parent: Option<String>,                 // None = direct child of root
    children: Mutex<Vec<String>>,
}
```

Methods:
- `register_spawn(parent_sid, new_sid, kind) -> Result<(), SpawnError>` — checks caps, links.
- `terminate(caller_sid, target_sid) -> Result<(), TerminateError>` — verifies caller is parent-of or root, cascades depth-first.
- `cascade_kill(sid)` — recursive child termination before own.
- `forget_session(sid)` — detaches from parent (already exists; extend to also drop children entry).

`peer_spawn` in `lastty-mcp`: calls a Tauri command `spawn_child_agent(caller_sid, kind, prompt)` that:
1. Asks `TerminalManager` to allocate a pane slot.
2. Calls `PeerRouter::register_spawn` for cap check.
3. Triggers the same launch path as a rule-spawned agent (`launch_agent`), passing the tree linkage + prompt.
4. Auto-layout: new pane splits off the caller's pane (existing layout manager has `split_right(parent_pane)`).
5. Returns the new `session_id`.

`peer_terminate` → Tauri command `terminate_child_agent(caller_sid, target_sid)` → router validation → `TerminalManager::close_session(target_sid)` which fires the existing `ChildExit` path.

## Block G — Request/reply plumbing

`peer_request` in `lastty-mcp` is a long-running MCP tool. The server:

1. Generates a `correlation_id` (UUID).
2. Registers a oneshot channel `(correlation_id → Sender<ReplyBody>)` in its local state.
3. Sends `PeerMessage::Dm { to, body, correlation_id }` over the control socket.
4. Awaits the receiver with the caller-supplied timeout.
5. On receive: returns reply body as tool result. On timeout: returns error.

Router changes: when a `Reply` arrives, if its `correlation_id` has an entry in a new `mcp_waiters: DashMap<CorrelationId, SessionId>` map, route the reply body back via the control socket to that session's `lastty-mcp` process, which releases the oneshot.

Control socket already supports bidirectional framing in the accept loop — extend to multi-message (currently writes peer messages in only one direction). NDJSON framing already used; reply routing is one new message type on the wire.

## Block H — Hardening

- `[agent.peer]` permissions parsing already sketched in prior plan; enforcement guard at router `route()` entry.
- Approval fold-in: rewrite `AgentUiMessage::Approval` in `emit_agent_ui` to `PeerMessage::Dm { to: User, body: {...}, correlation_id }`. `BusEvent::UserApproval` remains as a derived event so existing approval rules don't break.
- On Lastty startup: scan `$TMPDIR/lastty-*/`, unlink any whose session isn't in the live set.
- Socket cleanup on parent crash: startup scan handles it.

## Block V — Validation harness

`lastty-mcp/tests/peer_roundtrip.rs` (new; mirrors what the deleted `lastty-peer` test would have covered):

- MCP-path integration test: spawn `lastty-mcp` as a child, speak MCP to it, verify tool calls result in correct `PeerMessage`s on a mock control socket.
- Stdin-push roundtrip: drive a fake pane, emit OSC 7770 `Peer::Post`, verify stdin injection format.
- Caps: 9 spawn attempts; 9th errors.
- Cascade kill: spawn A→B→C; kill A; verify B and C cleaned up.

## File layout (new + changed)

**New:**
- `lastty-mcp/` workspace crate — dual-mode binary. Default: stdio MCP server that reads `$PANE_CONTROL_SOCKET`, exposes MCP tools, translates to/from `PeerMessage`. With subcommand args: one-shot CLI (`lastty-mcp post|dm|join|leave|presence …`).
- `src-tauri/src/terminal/mcp_injection.rs` — per-harness spawn-args materialization.
- `src-tauri/src/peer/tree.rs` — `Tree` state.
- `src-tauri/src/peer/framing.rs` — `format_push_line`.

**Changed:**
- `lastty-peer/` — **deleted** from the workspace. Remove from root `Cargo.toml` members. All uses go to `lastty-mcp` one-shot CLI.
- `src-tauri/src/peer/outbound.rs` — replace OSC 7771 body with stdin push; gate per-session mode.
- `src-tauri/src/peer/mod.rs` — extend with `Tree` + spawn/terminate entry points + correlation→waiter routing for `peer_request`.
- `src-tauri/src/terminal/session.rs` — new tempdir layout, calls into `mcp_injection`; remove `lastty-peer` PATH-prepend block.
- `src-tauri/src/agents.rs` — `[agent.mcp]` / `[agent.spawn]` / `[runtime]` sections.
- `src-tauri/src/commands.rs` — `spawn_child_agent`, `terminate_child_agent` commands.
- `src-tauri/tauri.conf.json` — `externalBin` entry for `lastty-mcp` only.

**Deleted:**
- `docs/plan/agent-to-app.plan.md` (superseded)
- `docs/plan/agent-to-agent.plan.md` (superseded)

## Hero demo flow

```
User → Claude (pane 0): "implement src/foo parser and have it reviewed"

Claude tool-call:
  peer_spawn(kind="codex", prompt="when I DM you a file path, review it")
    → "codex@b1c"
    → pane 1 tiles alongside pane 0; Codex boots with MCP config injected

Claude:                              writes src/foo.rs
Claude tool-call:
  peer_request(to="session:codex@b1c",
               body={text:"review src/foo.rs"},
               timeout_ms=60000)
    ← parks (zero cost while waiting)

Codex (pane 1) receives stdin push:
  [peer:claude-code@a3f] review src/foo.rs

Codex reads the file, tool-call:
  peer_reply(correlation_id=<auto>,
             body={verdict:"lgtm", nits:["line 42"]})

Claude's peer_request returns { verdict: "lgtm", nits: ["line 42"] }.
Claude fixes line 42.
Claude tool-call:
  peer_terminate(session_id="codex@b1c")
    → pane 1 closes.

Claude tool-call:
  ui_finished(summary="implemented and reviewed")
    → pane 0 header shows done.
```

User saw: two panes appear, work happen, one pane disappear, status turn green. No config, no approvals, no manual wiring.

## Key decisions

- **MCP as primary discovery surface.** The two agents that matter (Claude Code, Codex) speak MCP natively. OSC-as-discovery has no precedent in terminal ecosystems; MCP tool descriptions are how an untrained LLM learns a new capability.
- **OSC 7770 stays as the substrate under `ui_*` MCP tools.** Existing parser + rendering pipeline unchanged. MCP tools emit OSC internally.
- **Stdin push over OSC 7771 for inbound.** Uses the harness's existing async-stdin-handling (the same mechanism that lets a human type during generation). No new interrupt primitive, no harness modifications.
- **`peer_request` as blocking MCP tool.** Zero cost while parked; matches the model's imperative request/response mental model. Cleaner than pub/sub for the spawn-review-close flow.
- **Hierarchy is a tree, not a mesh.** Lifecycle flows down; messaging is flat. Parent-controls-child is the only lifecycle authority below root.
- **Cascade kill on parent death.** Simpler than reparenting; avoids surprise-owned agents appearing under the user.
- **Coexistence by default.** User's existing MCP servers remain loaded inside Lastty panes. Opt-in isolation via `agents.toml` for users who want a clean slate.
- **Zero user config post-install.** `--mcp-config` (Claude Code), `-c` overrides (Codex), tempdir-scoped — never touches user's home or project cwd.
- **No agent approval on spawn (v1).** Caps do the safety work. Per-agent `can_spawn` allowlist in `agents.toml` for users who want stricter control.

## Non-goals

- Cross-machine transport.
- Persistent history beyond the 50-message ring buffer.
- Mid-computation preemption of a running model turn.
- Agent-to-agent encryption or auth beyond `agents.toml` allowlists.
- Schema versioning — one version, break when needed.
- Subtree addressing (`Addr::Descendants`, `Addr::Parent`).
- Reactions / mentions / typing indicators.
- Windows named pipes.
- Reparenting on parent death.

## Risks / known debt

- **MCP client quirks.** Claude Code and Codex behave slightly differently on `-c` override parsing (Codex) and on `--mcp-config` merge semantics (Claude Code). Block D should run a matrix test (flag + config file) for both before shipping.
- **Stdin push during heavy output.** Visible interleaving is possible if the debounce is too aggressive or too loose. 50ms is a starting number; may need tuning per-harness.
- **Cap errors from `peer_spawn`.** Models may retry on error. Tool description must say "do not retry `peer_spawn` on cap errors; the cap is a hard limit." Hopefully sufficient — if not, rate-limit at the router.
- **Ring buffer under a chatty channel.** 50 messages in 5s → late-joiners see 5s of context. Per-channel TTL fixes it when it bites.
- **MCP stdio process per pane.** For N panes we run N `lastty-mcp` processes. Each is tiny (~5MB RSS), but at 8 panes that's ~40MB overhead. Acceptable; revisit if it becomes visible.
- **Approval latency.** Folding approvals into the peer path adds one hop (router → ChatPanel → user click → back through router). Previously `BusEvent::UserApproval` was synchronous from emit to UI. Likely imperceptible (<10ms); measure during Block H.
- **Claude Code --mcp-config bug #17299.** Upstream has a merge bug; if we hit it, fall back to additive `-c`-style or document the workaround.
