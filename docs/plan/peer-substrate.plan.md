# Peer Substrate — Agent↔App + Agent↔Agent Messaging

Branch: `feat/peer-substrate`. Ships the agent→app rendering path and the peer-messaging substrate (agent↔agent, agent↔user) described in `docs/plan/agent-to-app.plan.md` and `docs/plan/agent-to-agent.plan.md`.

## Overview

Two originally-separate plans, merged into one sequence because they share the same React/store plumbing:

1. **Agent → App**: wire the existing OSC 7770 parse path (already 70% done on the Rust side) into a Zustand store so React components actually render agent status, progress, tool calls, notifications.
2. **Agent ↔ Agent + Agent ↔ User**: add a `PeerRouter` on top of the existing `EventBus`, new OSC 7770/7771 peer wire types, channels + ring buffer + presence, and a first-class user peer via a chat panel. Opt-in Unix socket transport follows later.

## Architecture (chosen from 3 parallel proposals)

**Pragmatic module layout** + **cherry-picks from clean-architecture**:

- Module layout under `src-tauri/src/peer/`: `mod.rs` (PeerRouter), `channel.rs` (ChannelMap + 50-msg ring), `outbound.rs` (single `deliver()` function — the Block D swap point).
- Concurrency: `Arc<PeerRouter>` in Tauri state, `std::Mutex<ChannelMap>` (never held across await), `DashMap` for presence + correlation-owner tracking.
- Transport: single `outbound::deliver()` function body picks OSC today; Block D replaces the body to prefer the socket when connected. No trait abstraction for N=2 transports.
- BusEvent shape: **structured** `from: Addr, to: Addr, channel: Option<String>` (not flattened strings). Keeps the wire model and bus model aligned.
- Correlation tracking: included in Block B (10 lines), not deferred to E. Prevents reply-ID replay.
- `PANE_CONTROL_SOCKET` rename → `LASTTY_SOCK` deferred to Block D with the socket refactor.

Full comparison and rationale lived in the planning conversation; decisions locked before implementation.

## Block map

| Block | Scope | State |
|-------|-------|-------|
| **A** | Agent→app rendering (Zustand store, overlay/toast extract) | **DONE** |
| **B** | Peer substrate over OSC only (router, channels, presence, correlation, async rule launch fix, chat panel) | **DONE** |
| **(checkpoint)** | End-to-end verify A+B with synthetic peer OSC in a shell pane | **IN PROGRESS** — user testing |
| **C** | Claude/Codex context injection (manual pairing session) | PENDING |
| **D** | Unix socket transport + `lastty-agent-sdk` crate (background worktree) | PENDING |
| **E** | Hardening: permissions, approval fold-in, rule filters, socket cleanup | PENDING |

## Commits on this branch

```
bc814b1 feat: agent UI store and extracted overlay/toast components     [Block A]
95e7fb6 feat: peer protocol types, BusEvent peer variants, async rule launch  [Block B.1]
05804ba feat: PeerRouter with channels, presence, correlation tracking   [Block B.2]
879cf46 feat: peer store, chat panel, bus:event wiring for peer messages [Block B.3]
40aca91 fix: route peer messages off agent:ui channel; reducer default    [checkpoint fix]
```

## Block A — Agent→App rendering (DONE)

**Delivered:**
- `zustand` added to `package.json`
- `src/app/agentStore.ts` — wraps existing `reduceAgentMessage` from `agentUi.ts`, exposes `useAgentSession`, `useVisibleToasts`, `useBlockedSessionIds` selectors
- `src/app/agentStore.test.ts` — 4 tests: per-session routing, approval resolution, forget, no-op on missing session
- `src/components/agent/AgentInspector.tsx` — extracted from inline definition in `TerminalWorkspace.tsx` (was at line 2205)
- `src/components/agent/NotificationToasts.tsx` — extracted; 1s-tick internal clock, 5s notification TTL
- `src/TerminalWorkspace.tsx` — removed `agentUiBySession` local state, removed prop-drilling through `RenderLayoutCtx` and `DesktopStage`. PaneTile now reads via `useAgentSession(sessionId)`.
- `src/components/agent/ViewPreview.tsx` — refactored leaf render into a `LeafPreview` component that uses `useAgentSession`
- Session-exit policy: drop state (preserves pre-existing behavior). Replay across session boundaries deferred.
- `pane-cli` roundtrip harness from the original plan step 5: **deferred** — it's a test tool, and the same harness will serve Block B, so it makes sense to build it once Block C needs it.

**Verification:** All 794 frontend tests pass. `pnpm exec tsc --noEmit` clean. No Rust changes in this block.

## Block B — Peer substrate over OSC (DONE)

### B.1 — Protocol + BusEvent (commit `95e7fb6`)

**pane-protocol:**
- `pane-protocol/src/peer.rs`:
  - `Addr` — `Session(String) | Agent(String) | Channel(String) | User`. `User` variant uses a custom serde shim so it serializes as `{"kind":"user"}` without a null `id`.
  - `PeerMessage` — `Dm | Post | Join | Leave | Presence | Reply` with `correlation_id: Option<String>` (String, not Uuid, to keep the crate dep-free).
  - `Presence` — `Thinking | Waiting | Idle | Done` with `as_str()` for BusEvent template rendering.
  - Helper methods: `Addr::agent_id()`, `Addr::channel()`, `Addr::is_user()`, `PeerMessage::kind()`.
- `pane-protocol/src/message.rs`: added `AgentUiMessage::Peer(PeerMessage)` wrapping variant.
- `pane-protocol/src/lib.rs`: re-exports `Addr`, `PeerMessage`, `Presence`.
- 5 unit tests: Dm roundtrip, `User` flat serialization, Post with reply_to, Presence roundtrip, Addr helpers.

**BusEvent extensions (`src-tauri/src/bus.rs`):**
- `BusEvent::PeerMessage { session_id, from: Addr, to: Addr, kind: String, channel: Option<String>, correlation_id: Option<String>, body: Value }`
- `BusEvent::PeerPresence { session_id, from: Addr, status: Presence }`
- Updated all 5 exhaustive accessor match arms (`kind`, `session_id`, `agent_id`, 4 typed accessors, `template_value`)
- Added peer-specific accessors: `channel()`, `from_agent()`, `to_agent()`, `presence()`

**RuleFilter extensions (`src-tauri/src/agents.rs`):**
- New optional fields: `channel`, `from_agent`, `to_agent`, `presence`
- Corresponding guards added to `rule_matches` in `bus.rs`
- Template variables `{{channel}}`, `{{from_agent}}`, `{{to_agent}}`, `{{presence}}` resolve in `render_template`

**Async rule launch fix:**
- `run_rule_action` was `spawn_blocking(|| sync launch_agent(...))` — saturates the Tokio blocking pool under a rule storm.
- Replaced with `spawn(async { spawn_blocking(move || sync launch_agent(...)).await })` — outer spawn returns immediately; blocking work is scoped to a single launch.

### B.2 — PeerRouter (commit `05804ba`)

**New module `src-tauri/src/peer/`:**
- `mod.rs` — `PeerRouter<R>` struct. Fields: `app: AppHandle<R>`, `channels: Mutex<ChannelMap>`, `presence: DashMap<String, Presence>`, `correlation_owners: DashMap<String, String>`.
  - `ingest_from_session(session_id, message)` — called synchronously from `emit_agent_ui` on the PTY read thread
  - `ingest_from_user(context_session_id, message)` — called from the `send_peer_message` Tauri command
  - `forget_session(session_id)` — called on `Event::ChildExit`
  - `route(...)` dispatches per `PeerMessage` variant. Per-variant flow:
    - `Dm`: record correlation owner, publish bus event, fan out to `Addr` resolution (Session / Agent / Channel / User)
    - `Post`: append to ring, publish bus event, fanout to subscribers
    - `Join`: add subscriber, publish bus event, replay ring back to joiner
    - `Leave`: remove subscriber, publish bus event
    - `Presence`: update presence map, publish bus event
    - `Reply`: validate against `correlation_owners` (silent drop on mismatch — replay protection), publish bus event, deliver to originator session
- `channel.rs` — `ChannelMap` with `join/leave/post/forget_session/subscribers_snapshot`. Ring capped at 50 via `VecDeque::pop_front` when full. 4 unit tests: replay, cap, leave, multi-channel forget.
- `outbound.rs` — single `deliver(manager, session_id, message)` function. Encodes as OSC 7771 and writes to PTY via `session.write()`. `fanout()` helper skips the source session. **This is the Block D swap point.**

**Wire-up:**
- `main.rs` registers `Arc::new(PeerRouter::new(app.handle().clone()))` in Tauri state
- `session.rs::emit_agent_ui` dispatches `AgentUiMessage::Peer(_)` to the router and returns early (no `agent:ui` emit — see fix below)
- `event_proxy.rs::Event::ChildExit` calls `router.forget_session(...)`
- `commands.rs::send_peer_message` — Tauri command for user-as-peer sends
- `main.rs::invoke_handler` registers the command

### B.3 — Frontend peer store + chat panel (commit `879cf46`)

- `src/app/peerTypes.ts` — mirrors the Rust wire types: `Addr`, `Presence`, `PeerMessage`, `PeerMessageEvent`, `PeerPresenceEvent`. `addrLabel(addr)` helper for UI display.
- `src/app/peerStore.ts` — Zustand store:
  - `channelMessages: Record<string, ChannelEntry[]>` — per-channel history, capped at 200
  - `presence: Record<string, Presence>` — per-session status
  - `ingestMessage(event)` / `ingestPresence(event)`
  - Hooks: `useChannelMessages(channel)`, `useAgentPresence(sessionId)`
  - `sendPeerMessage(message, contextSessionId?)` wraps the Tauri invoke
- `src/app/peerStore.test.ts` — 4 tests: post ingestion, 200-entry cap, presence, dm-to-session is ignored by channel view
- `src/components/peer/ChatPanel.tsx` — minimal floating chat (posts to `#general`). Toggled by a 💬 bubble mounted on `TerminalWorkspace`.
- `TerminalWorkspace.tsx`:
  - New `bus:event` listener splits `peer_message` and `peer_presence` into `peerStore`
  - Mounts `<ChatPanel open={chatOpen} ...>` and the toggle bubble

### Checkpoint fix (commit `40aca91`)

**Bug hit during verification:** sending a `Presence` peer OSC from a shell pane wiped the session's agent state and appeared to crash the UI.

**Cause:** `emit_agent_ui` routed the Peer variant to the router **and** still fired the standard `agent:ui` Tauri emit. The frontend's `agentUi.ts` reducer has no `case "Peer"`, so the switch fell off the end and returned `undefined`, which replaced the session's `AgentSessionState` in the Zustand store. Subsequent renders read `undefined` as `EMPTY`.

**Fix:**
- `emit_agent_ui` now `return`s early for `AgentUiMessage::Peer` — peer messages ride only the `bus:event` path and the `peerStore`, never `agent:ui`.
- Added `default: return state;` to `reduceAgentMessage` as defense-in-depth.

## Verification checklist (where we are now)

Three things to confirm before moving to Block C:

1. **Block A regression**: launch Claude or Codex, confirm status badge / progress bar / tool-call inspector / notifications / approval input all still work (they read the Zustand store now instead of useState).
2. **Agent→User (inbound peer) via shell pane as fake agent**:
   ```bash
   # In any lastty shell pane
   printf '\033]7770;{"type":"Peer","data":{"type":"post","channel":"general","body":{"text":"hi from pane"}}}\007'
   ```
   Click the 💬 bubble — should see `s:<id> hi from pane` in `#general`.
3. **User→Agent (outbound peer)** with two panes both joined to `#general`; posting from the chat panel should write OSC 7771 bytes into both panes' PTY input.

Each step proves a different slice of the plumbing. All three passing = A+B green; move on to Block C.

## Block C — Context injection for Claude & Codex (PENDING, pair-programming session)

**Decisions already locked:**
- No file writes into user repos (no managed `CLAUDE.md`/`AGENTS.md`). CLI-native injection only.
- Per-adapter flag: Claude `--append-system-prompt <text>`, Codex TBD (stdin preamble or `--system-prompt` — verify)
- New `AgentDefinition.system_context` field. Per-adapter renderer reads it and appends to `default_args` or pipes via stdin.
- The injected context will include multiple example OSC emit snippets plus a self-check ("emit one `Presence::Thinking` now") so the agent can grade its own emission.

**What the session will look like:**
1. Draft the exact Markdown/prose snippet the agents see.
2. Run Claude in a scratch worktree with `--append-system-prompt "$snippet"`, ask it to "DM the user saying hi", watch for OSC 7770 bytes with `strace` / `script` / `pane-cli`.
3. Iterate the snippet until Claude reliably emits well-formed `PeerMessage::Dm { to: Addr::User, ... }`.
4. Repeat with Codex; unify where possible.
5. Add the `system_context` field + adapter rendering on the Rust side.

**Deliverables**: `AgentDefinition.system_context` field, per-adapter plumbing in `agents.rs`, committed context prose, and a working end-to-end demo with Claude and Codex.

## Block D — Unix socket transport + SDK (PENDING, delegate to worktree)

Background-worktree ready. Scope:
- Rename `PANE_CONTROL_SOCKET` → `LASTTY_SOCK` in `session.rs` env injection.
- Extend the accept loop in `session.rs:256-273` to support multi-message bidirectional newline-JSON framing (currently write-only, single connection).
- Replace `outbound::deliver` body: prefer socket if `session.control_connected` is true, fall back to OSC.
- New crate `crates/lastty-agent-sdk/`: `connect()`, `dm()`, `post()`, `join()`, `on_message()`. Published so first-party agents and examples can link it.
- Update Block C context prose to mention the socket when `LASTTY_SOCK` is set.

## Block E — Hardening (PENDING)

Plug-in points already exist in the router; each fold-in is 1-2 lines at a known call site.
- `[agent.peer]` section in `agents.toml`: `can_dm`, `can_join`, `auto_join`. Parse into `AgentPeerPolicy`, pass to `PeerRouter::register_session` (new method). Enforce via one `if !self.permits(...)` guard at the top of `route()`.
- Approval fold-in: rewrite `AgentUiMessage::Approval` in `emit_agent_ui` before dispatch: `PeerMessage::Dm { to: Addr::User, body: {approval_id, message, options}, correlation_id }`. User's button click in the UI emits `PeerMessage::Reply { correlation_id, body: { choice } }`. Keep `BusEvent::UserApproval` as a derived event.
- Socket cleanup on parent crash: on lastty startup, unlink any `lastty/*.sock` paths whose session isn't in the live set.
- Rule filter extensions already landed in B.1. Approval rules via `from_agent = "user"` + `to_agent = "..."` will now match.

## Deferred / not-yet-scheduled

- `pane-cli` roundtrip test harness (both plan docs mention it). Land alongside Block C so we have a programmable oracle for Claude/Codex emit tests.
- Reactions, mentions, typing indicators — all UI sugar on top of `Post`, explicitly out-of-scope for v1 per the original agent-to-agent plan.
- Cross-machine transport — out of scope.
- Windows named pipes — deferred until a Windows user asks.

## Known MVP debt flagged

- Ring buffer replay is unbounded in time. If a chatty channel fills 50 messages in 5 seconds, a late joiner sees only the last 5s. Acceptable; revisit with per-channel TTL when it bites.
- OSC 7770 payload cap is 64 KB. Large `Post` bodies silently truncate. Socket (Block D) removes the limit. SDK should warn when `LASTTY_SOCK` is set but unused and the payload grows large.
- `PANE_CONTROL_SOCKET` still holds its legacy name in Block B. Rename in D.
- `Addr::Agent` is a broadcast across all live sessions of that agent id — documented as a feature; rule authors need to remember this when writing `from_agent` / `to_agent` filters.
