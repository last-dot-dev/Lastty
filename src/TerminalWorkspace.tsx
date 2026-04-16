import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";

import KeyboardHelpOverlay from "./components/KeyboardHelpOverlay";
import { detectPlatform, matchBinding } from "./app/keybindings";

import {
  emptyAgentSessionState,
  parseAgentMessage,
  reduceAgentMessage,
  resolveApproval,
  toolCallCount,
  visibleNotifications,
  type AgentSessionState,
  type ToolCallRecord,
} from "./app/agentUi";
import {
  assignBranchColor,
  deriveAgentStatus,
  deriveAgentType,
  deriveBranchName,
  deriveProgressPct,
  deriveTaskName,
  type AgentStatus,
} from "./app/agentDerived";
import AgentShell from "./components/agent/AgentShell";
import WindowHeader from "./components/agent/WindowHeader";
import ProgressBar from "./components/agent/ProgressBar";
import ReplyInput from "./components/agent/ReplyInput";
import EdgeSpawner, { type SpawnDirection } from "./components/agent/EdgeSpawner";
import ThemeToggle from "./components/agent/ThemeToggle";
import type { BranchRow } from "./components/agent/BranchList";
import type { DesktopEntry } from "./components/agent/DesktopStrip";
import type { BlockedSessionRef } from "./components/agent/AlertBar";
import { useThemeOverride } from "./hooks/useThemeOverride";
import {
  activeDesktop,
  attachPaneToDesktop,
  closeDesktop,
  closePane,
  createDesktop,
  createPaneRecord,
  createWorkspace,
  detachPane,
  findDesktopForPane,
  focusAdjacentPane,
  focusPane,
  nextDesktopIdInDirection,
  orderedPaneIds,
  renameDesktop,
  renamePane,
  resizeSplit,
  splitAtPane,
  splitPane,
  swapPanes,
  switchDesktop,
  toggleMaximize,
  type DesktopState,
  type LayoutPath,
  type LayoutNode,
  type SplitDirection,
  type SplitSide,
  type WorkspaceState,
} from "./app/layout";
import {
  buildPersistedWorkspaceState,
  buildRestoredWorkspaceState,
  persistWorkspaceState,
  readPersistedWorkspaceState,
  type PersistedTerminalSnapshot,
} from "./app/sessionRestore";
import TerminalViewport from "./components/TerminalViewport";
import { releaseTerminalHost } from "./components/TerminalHostRegistry";
import ViewPreview from "./components/agent/ViewPreview";
import {
  createTerminal,
  getPrimarySessionId,
  killTerminal,
  launchAgent,
  listAgents,
  listSessions,
  respondToApproval,
  restoreTerminalSessions,
  type AgentDefinition,
  type AgentUiEvent,
  type LaunchAgentResult,
  type SessionExitEvent,
  type SessionInfo,
  type SessionTitleEvent,
} from "./lib/ipc";

export default function TerminalWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [sessionInfoById, setSessionInfoById] = useState<Record<string, SessionInfo>>({});
  const [agentUiBySession, setAgentUiBySession] = useState<
    Record<string, AgentSessionState>
  >({});
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const platform = useMemo(() => detectPlatform(), []);
  const [launching, setLaunching] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [isolateWorktree, setIsolateWorktree] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [hydrated, setHydrated] = useState(false);
  const [terminalSnapshotsBySessionId, setTerminalSnapshotsBySessionId] = useState<
    Record<string, PersistedTerminalSnapshot>
  >({});
  const [restoredSnapshotsBySessionId, setRestoredSnapshotsBySessionId] = useState<
    Record<string, PersistedTerminalSnapshot>
  >({});
  const sessionCreationOrder = useMemo(
    () => Object.keys(sessionInfoById),
    [sessionInfoById],
  );

  const currentDesktop: DesktopState | null = workspace ? activeDesktop(workspace) : null;
  const focusedPaneId = currentDesktop?.focusedPaneId ?? null;
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);

  const theme = useThemeOverride();

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const loadedAgents = await listAgents().catch((error) => {
          console.error("failed to load agents", error);
          return [] as AgentDefinition[];
        });
        if (cancelled) return;

        setAgents(loadedAgents);
        setSelectedAgentId((current) => current || loadedAgents[0]?.id || "");

        const persisted = readPersistedWorkspaceState();
        if (persisted?.panes.length) {
          try {
            const restoredSessions = await restoreTerminalSessions(
              persisted.panes.map((pane) => ({ cwd: pane.cwd })),
            );
            if (cancelled) return;
            const restored = buildRestoredWorkspaceState(persisted, restoredSessions);
            if (restored) {
              setSessionInfoById(
                Object.fromEntries(
                  restoredSessions.map((session) => [session.session_id, session]),
                ),
              );
              setWorkspace(restored.workspace);
              setRestoredSnapshotsBySessionId(restored.restoredSnapshotsBySessionId);
              setTerminalSnapshotsBySessionId(restored.restoredSnapshotsBySessionId);
              return;
            }
          } catch (error) {
            console.error("failed to restore persisted workspace", error);
          }
        }

        const sessions = await listSessions().catch((error) => {
          console.error("failed to load sessions", error);
          return [] as SessionInfo[];
        });
        if (cancelled) return;
        setSessionInfoById(Object.fromEntries(sessions.map((session) => [session.session_id, session])));

        const sessionId = await getPrimarySessionId().catch((error) => {
          console.error("failed to load primary session", error);
          return null;
        });
        if (cancelled || !sessionId) return;

        const sessionTitle =
          sessions.find((session) => session.session_id === sessionId)?.title || "shell";
        setWorkspace((current) =>
          current ?? createWorkspace(createPaneRecord(sessionId, sessionTitle)),
        );
      } finally {
        if (!cancelled) {
          setHydrated(true);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspace) {
      const firstSessionId = Object.keys(sessionInfoById)[0];
      if (firstSessionId) {
        setWorkspace(
          createWorkspace(
            createPaneRecord(firstSessionId, sessionInfoById[firstSessionId]?.title || "shell"),
          ),
        );
      }
    }
  }, [sessionInfoById, workspace]);

  useEffect(() => {
    if (!hydrated || !workspace) {
      return;
    }
    const persisted = buildPersistedWorkspaceState(
      workspace,
      sessionInfoById,
      terminalSnapshotsBySessionId,
    );
    if (!persisted) {
      return;
    }
    try {
      persistWorkspaceState(persisted);
    } catch (error) {
      console.error("failed to persist workspace state", error);
    }
  }, [hydrated, sessionInfoById, terminalSnapshotsBySessionId, workspace]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    void listen<SessionTitleEvent>("session:title", (event) => {
      setWorkspace((current) =>
        current
          ? renamePane(current, event.payload.session_id, event.payload.title || "shell")
          : current,
      );
      setSessionInfoById((current) => ({
        ...current,
        [event.payload.session_id]: {
          ...(current[event.payload.session_id] ?? {
            session_id: event.payload.session_id,
            title: "shell",
            cwd: "",
            prompt: null,
            agent_id: null,
            prompt_summary: null,
            worktree_path: null,
            control_connected: false,
            started_at_ms: 0,
          }),
          title: event.payload.title || "shell",
        },
      }));
    }).then((fn) => unsubs.push(fn));

    void listen<SessionExitEvent>("session:exit", (event) => {
      setWorkspace((current) =>
        current
          ? renamePane(
              current,
              event.payload.session_id,
              `exited (${event.payload.code ?? "?"})`,
            )
          : current,
      );
    }).then((fn) => unsubs.push(fn));

    void listen<AgentUiEvent>("agent:ui", (event) => {
      const message = parseAgentMessage(event.payload.message);
      if (!message) return;
      setAgentUiBySession((current) => ({
        ...current,
        [event.payload.session_id]: reduceAgentMessage(
          current[event.payload.session_id] ?? emptyAgentSessionState(),
          message,
        ),
      }));
    }).then((fn) => unsubs.push(fn));

    return () => {
      for (const unlisten of unsubs) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (!workspace) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const match = matchBinding(event, platform);
      if (!match) return;
      const { binding } = match;
      const activePaneId = activeDesktop(workspace).focusedPaneId;

      switch (binding.id) {
        case "help.toggle":
          event.preventDefault();
          setHelpOpen((open) => !open);
          return;
        case "desktop.new":
          event.preventDefault();
          void handleNewDesktop();
          return;
        case "desktop.next":
          event.preventDefault();
          handleCycleDesktop(1);
          return;
        case "desktop.prev":
          event.preventDefault();
          handleCycleDesktop(-1);
          return;
        case "desktop.jump":
          if (binding.payload === undefined) return;
          event.preventDefault();
          handleJumpToDesktopIndex(binding.payload - 1);
          return;
        case "focus.left":
        case "focus.down":
        case "focus.up":
        case "focus.right": {
          event.preventDefault();
          const direction =
            binding.id === "focus.left"
              ? "left"
              : binding.id === "focus.right"
                ? "right"
                : binding.id === "focus.up"
                  ? "up"
                  : "down";
          setWorkspace((current) =>
            current ? focusAdjacentPane(current, direction) : current,
          );
          return;
        }
        case "pane.split.horizontal":
          if (!activePaneId) return;
          event.preventDefault();
          void handleSplit(activePaneId, "horizontal");
          return;
        case "pane.split.vertical":
          if (!activePaneId) return;
          event.preventDefault();
          void handleSplit(activePaneId, "vertical");
          return;
        case "pane.close":
          if (!activePaneId) return;
          event.preventDefault();
          void handleClose(activePaneId);
          return;
        case "agent.launch":
          event.preventDefault();
          setLauncherOpen(true);
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [workspace, platform]);

  async function handleSplit(paneId: string, direction: SplitDirection) {
    const sessionId = await createTerminal();
    upsertSession({
      session_id: sessionId,
      title: `shell ${Object.keys(sessionInfoById).length + 1}`,
      cwd: "",
      prompt: null,
      agent_id: null,
      prompt_summary: null,
      worktree_path: null,
      control_connected: false,
      started_at_ms: 0,
    });
    setWorkspace((current) => {
      if (!current) return current;
      return splitPane(
        current,
        paneId,
        direction,
        createPaneRecord(sessionId, `shell ${Object.keys(current.panes).length + 1}`),
      );
    });
  }

  async function handleLaunchAgent() {
    if (!workspace || !selectedAgentId) return;
    const activePaneId = activeDesktop(workspace).focusedPaneId;
    if (!activePaneId) return;
    setLaunching(true);
    try {
      const focusedPane = workspace.panes[activePaneId];
      const focusedSession = focusedPane ? sessionInfoById[focusedPane.sessionId] : undefined;
      const result = await launchAgent({
        agent_id: selectedAgentId,
        prompt: agentPrompt || null,
        cwd: focusedSession?.worktree_path ?? null,
        isolate_in_worktree: isolateWorktree,
        branch_name: isolateWorktree ? branchName || null : null,
      });
      applyLaunchedSession(activePaneId, result);
      setLauncherOpen(false);
      setAgentPrompt("");
      setBranchName("");
      setIsolateWorktree(false);
    } catch (error) {
      console.error("failed to launch agent", error);
    } finally {
      setLaunching(false);
    }
  }

  async function handleClose(paneId: string) {
    const pane = workspace?.panes[paneId];
    if (!pane) return;
    const sessionId = pane.sessionId;
    await killTerminal(sessionId).catch((error) => {
      console.error("failed to kill terminal", error);
    });
    releaseTerminalHost(sessionId);
    setWorkspace((current) => (current ? closePane(current, paneId) : current));
  }

  function upsertSession(session: SessionInfo) {
    setSessionInfoById((current) => ({
      ...current,
      [session.session_id]: session,
    }));
  }

  function handleToggleMaximizePane(paneId: string) {
    setWorkspace((current) => (current ? toggleMaximize(current, paneId) : current));
  }

  async function handleNewDesktop() {
    const sessionId = await createTerminal();
    const title = `shell ${Object.keys(sessionInfoById).length + 1}`;
    upsertSession({
      session_id: sessionId,
      title,
      cwd: "",
      prompt: null,
      agent_id: null,
      prompt_summary: null,
      worktree_path: null,
      control_connected: false,
      started_at_ms: 0,
    });
    setWorkspace((current) =>
      current
        ? createDesktop(current, createPaneRecord(sessionId, title))
        : createWorkspace(createPaneRecord(sessionId, title)),
    );
  }

  async function handleNewShellInActiveDesktop() {
    if (!workspace) return;
    const desktopId = workspace.activeDesktopId;
    const desktop = activeDesktop(workspace);
    if (desktop.layout) return;
    const sessionId = await createTerminal();
    const title = `shell ${Object.keys(sessionInfoById).length + 1}`;
    const pane = createPaneRecord(sessionId, title);
    upsertSession({
      session_id: sessionId,
      title,
      cwd: "",
      prompt: null,
      agent_id: null,
      prompt_summary: null,
      worktree_path: null,
      control_connected: false,
      started_at_ms: 0,
    });
    setWorkspace((current) => {
      if (!current) return current;
      return {
        ...current,
        panes: { ...current.panes, [pane.id]: pane },
        desktops: current.desktops.map((entry) =>
          entry.id === desktopId
            ? {
                ...entry,
                layout: { type: "leaf", paneId: pane.id },
                focusedPaneId: pane.id,
              }
            : entry,
        ),
      };
    });
  }

  function handleSwitchDesktop(desktopId: string) {
    setWorkspace((current) => (current ? switchDesktop(current, desktopId) : current));
  }

  function handleRenameDesktop(desktopId: string, name: string) {
    setWorkspace((current) => (current ? renameDesktop(current, desktopId, name) : current));
  }

  async function handleCloseDesktop(desktopId: string) {
    if (!workspace) return;
    const { workspace: next, removedSessionIds } = closeDesktop(workspace, desktopId);
    if (next === workspace) return;
    setWorkspace(next);
    for (const sessionId of removedSessionIds) {
      killTerminal(sessionId).catch((error) => {
        console.error("failed to kill terminal", error);
      });
      releaseTerminalHost(sessionId);
    }
  }

  function handleDropPaneOnDesktop(paneId: string, desktopId: string) {
    setWorkspace((current) => {
      if (!current) return current;
      const detached = detachPane(current, paneId);
      const attached = attachPaneToDesktop(detached, paneId, desktopId);
      return switchDesktop(attached, desktopId);
    });
  }

  function handleDropPaneOnEdge(
    sourcePaneId: string,
    targetPaneId: string,
    side: SplitSide,
  ) {
    if (sourcePaneId === targetPaneId) return;
    setWorkspace((current) => {
      if (!current) return current;
      const targetDesktop = findDesktopForPane(current, targetPaneId);
      const next = splitAtPane(current, targetPaneId, sourcePaneId, side);
      if (targetDesktop) return switchDesktop(next, targetDesktop.id);
      return next;
    });
  }

  function handleDropPaneOnBody(sourcePaneId: string, targetPaneId: string) {
    if (sourcePaneId === targetPaneId) return;
    setWorkspace((current) => {
      if (!current) return current;
      const swapped = swapPanes(current, sourcePaneId, targetPaneId);
      const sourceDesktop = findDesktopForPane(swapped, sourcePaneId);
      return sourceDesktop ? switchDesktop(swapped, sourceDesktop.id) : swapped;
    });
  }

  function handleJumpToDesktopIndex(index: number) {
    setWorkspace((current) => {
      if (!current) return current;
      const target = current.desktops[index];
      if (!target) return current;
      return switchDesktop(current, target.id);
    });
  }

  function handleCycleDesktop(direction: 1 | -1) {
    setWorkspace((current) => {
      if (!current) return current;
      const targetId = nextDesktopIdInDirection(current, direction);
      return targetId ? switchDesktop(current, targetId) : current;
    });
  }

  function handleJumpToBlocked(sessionId: string) {
    if (!workspace) return;
    const pane = Object.values(workspace.panes).find(
      (entry) => entry.sessionId === sessionId,
    );
    if (!pane) return;
    const owningDesktop = findDesktopForPane(workspace, pane.id);
    setWorkspace((current) => {
      if (!current) return current;
      const switched = owningDesktop
        ? switchDesktop(current, owningDesktop.id)
        : current;
      return focusPane(switched, pane.id, owningDesktop?.id ?? switched.activeDesktopId);
    });
  }

  function handleTerminalSnapshot(sessionId: string, snapshot: PersistedTerminalSnapshot) {
    setTerminalSnapshotsBySessionId((current) => {
      const existing = current[sessionId];
      if (
        existing?.serializedBuffer === snapshot.serializedBuffer &&
        existing.cols === snapshot.cols &&
        existing.rows === snapshot.rows
      ) {
        return current;
      }
      return {
        ...current,
        [sessionId]: snapshot,
      };
    });
    setRestoredSnapshotsBySessionId((current) => {
      if (!(sessionId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function applyLaunchedSession(paneId: string, result: LaunchAgentResult) {
    upsertSession({
      session_id: result.session_id,
      title: result.pane_title,
      agent_id: selectedAgentId,
      cwd: result.cwd,
      prompt: agentPrompt || null,
      prompt_summary: agentPrompt || null,
      worktree_path: result.worktree_path ?? null,
      control_connected: false,
      started_at_ms: 0,
    });
    setWorkspace((current) => {
      if (!current) return current;
      return splitPane(
        current,
        paneId,
        "vertical",
        createPaneRecord(result.session_id, result.pane_title),
      );
    });
  }

  const toastNotifications = Object.entries(agentUiBySession).flatMap(([sessionId, state]) =>
    visibleNotifications(state, clock).map((notification) => ({
      sessionId,
      notification,
    })),
  );

  const branchRows: BranchRow[] = workspace
    ? sessionCreationOrder.map((sessionId) => {
        const pane = Object.values(workspace.panes).find(
          (entry) => entry.sessionId === sessionId,
        );
        const info = sessionInfoById[sessionId];
        const ui = agentUiBySession[sessionId];
        const status = deriveAgentStatus(ui, Boolean(ui?.finished));
        return {
          sessionId,
          paneId: pane?.id ?? null,
          branch: deriveBranchName(info),
          status,
          color: assignBranchColor(sessionId, sessionCreationOrder),
          focused: pane?.id === focusedPaneId,
          merged: false,
        };
      })
    : [];

  const blockedRefs: BlockedSessionRef[] = Object.entries(agentUiBySession)
    .filter(([, ui]) => ui.pendingApprovals.length > 0)
    .map(([sessionId]) => ({
      sessionId,
      taskName: deriveTaskName(sessionInfoById[sessionId]),
    }));

  const desktopEntries: DesktopEntry[] = workspace
    ? workspace.desktops.map((desktop) => {
        const paneIds = desktop.layout ? orderedPaneIds(desktop.layout) : [];
        const hasBlocked = paneIds.some((paneId) => {
          const pane = workspace.panes[paneId];
          return pane
            ? (agentUiBySession[pane.sessionId]?.pendingApprovals.length ?? 0) > 0
            : false;
        });
        return {
          id: desktop.id,
          name: desktop.name,
          paneCount: paneIds.length,
          hasBlocked,
        };
      })
    : [];

  const doneCount = Object.values(agentUiBySession).filter(
    (ui) => ui.pendingApprovals.length === 0 && ui.finished !== null,
  ).length;

  if (!workspace) {
    return (
      <div
        className="agent-root"
        style={{
          display: "grid",
          placeItems: "center",
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-secondary)",
        }}
      >
        Booting terminal workspace…
      </div>
    );
  }

  return (
    <div className="agent-root">
      <AgentShell
        blocked={blockedRefs}
        onJumpToBlocked={handleJumpToBlocked}
        branchRows={branchRows}
        doneCount={doneCount}
        onFocusBranch={(paneId) =>
          setWorkspace((current) => (current ? focusPane(current, paneId) : current))
        }
        desktops={desktopEntries}
        activeDesktopId={workspace.activeDesktopId}
        onSwitchDesktop={handleSwitchDesktop}
        onNewDesktop={() => void handleNewDesktop()}
        onCloseDesktop={(id) => void handleCloseDesktop(id)}
        onRenameDesktop={handleRenameDesktop}
        canAcceptPaneDrop={Boolean(draggingPaneId)}
        onDropPaneOnDesktop={(desktopId) => {
          if (draggingPaneId) handleDropPaneOnDesktop(draggingPaneId, desktopId);
        }}
        renderDesktopPreview={(desktopId) => {
          const desktop = workspace.desktops.find((entry) => entry.id === desktopId);
          if (!desktop) return null;
          return (
            <ViewPreview
              desktop={desktop}
              workspace={workspace}
              sessionInfoById={sessionInfoById}
              agentUiBySession={agentUiBySession}
              sessionCreationOrder={sessionCreationOrder}
            />
          );
        }}
        sidebarFooterExtras={
          <ThemeToggle override={theme.override} onCycle={theme.cycle} />
        }
      >
        <div className="agent-grid">
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {workspace.desktops.map((desktop) => {
              const active = desktop.id === workspace.activeDesktopId;
              return (
                <div
                  key={desktop.id}
                  className="agent-desktop-layer"
                  style={{
                    display: active ? "flex" : "none",
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    flexDirection: "column",
                  }}
                >
                  {desktop.layout ? (
                    renderLayout(desktop.layout, {
                      desktop,
                      workspace,
                      sessionInfoById,
                      agentUiBySession,
                      restoredSnapshotsBySessionId,
                      onCloseChrome: (paneId) => handleClose(paneId),
                      onToggleMaximize: handleToggleMaximizePane,
                      onResize: (path, handleIndex, delta, baseWeights) =>
                        setWorkspace((current) =>
                          current
                            ? resizeSplit(
                                current,
                                path,
                                handleIndex,
                                delta,
                                baseWeights,
                                desktop.id,
                              )
                            : current,
                        ),
                      onFocus: (paneId) =>
                        setWorkspace((current) =>
                          current ? focusPane(current, paneId, desktop.id) : current,
                        ),
                      onSnapshot: handleTerminalSnapshot,
                      onApproval: (sessionId, approvalId, choice) => {
                        void respondToApproval(sessionId, approvalId, choice).then(() => {
                          setAgentUiBySession((current) => ({
                            ...current,
                            [sessionId]: resolveApproval(
                              current[sessionId] ?? emptyAgentSessionState(),
                              approvalId,
                            ),
                          }));
                        });
                      },
                      onSpawnAdjacent: (paneId, direction) =>
                        void handleSplit(
                          paneId,
                          direction === "right" ? "horizontal" : "vertical",
                        ),
                      draggingPaneId,
                      onDragStartPane: (paneId) => setDraggingPaneId(paneId),
                      onDragEndPane: () => setDraggingPaneId(null),
                      onDropPaneOnEdge: handleDropPaneOnEdge,
                      onDropPaneOnBody: handleDropPaneOnBody,
                    })
                  ) : (
                    <EmptyDesktop onNewShell={() => void handleNewShellInActiveDesktop()} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </AgentShell>
      {launcherOpen && (
        <LaunchAgentModal
          agents={agents}
          branchName={branchName}
          isolateWorktree={isolateWorktree}
          launching={launching}
          onBranchNameChange={setBranchName}
          onClose={() => setLauncherOpen(false)}
          onIsolateWorktreeChange={setIsolateWorktree}
          onLaunch={handleLaunchAgent}
          onPromptChange={setAgentPrompt}
          onSelectedAgentIdChange={setSelectedAgentId}
          prompt={agentPrompt}
          selectedAgentId={selectedAgentId}
        />
      )}
      <KeyboardHelpOverlay
        onClose={() => setHelpOpen(false)}
        open={helpOpen}
        platform={platform}
      />
      <ToastStack notifications={toastNotifications} sessionInfoById={sessionInfoById} />
    </div>
  );
}

interface RenderLayoutCtx {
  desktop: DesktopState;
  workspace: WorkspaceState;
  sessionInfoById: Record<string, SessionInfo>;
  agentUiBySession: Record<string, AgentSessionState>;
  restoredSnapshotsBySessionId: Record<string, PersistedTerminalSnapshot>;
  onCloseChrome: (paneId: string) => Promise<void>;
  onToggleMaximize: (paneId: string) => void;
  onResize: (
    path: LayoutPath,
    handleIndex: number,
    delta: number,
    baseWeights: number[],
  ) => void;
  onFocus: (paneId: string) => void;
  onSnapshot: (sessionId: string, snapshot: PersistedTerminalSnapshot) => void;
  onApproval: (sessionId: string, approvalId: string, choice: string) => void;
  onSpawnAdjacent: (paneId: string, direction: SpawnDirection) => void;
  draggingPaneId: string | null;
  onDragStartPane: (paneId: string) => void;
  onDragEndPane: () => void;
  onDropPaneOnEdge: (sourcePaneId: string, targetPaneId: string, side: SplitSide) => void;
  onDropPaneOnBody: (sourcePaneId: string, targetPaneId: string) => void;
}

function renderLayout(
  node: LayoutNode,
  ctx: RenderLayoutCtx,
  path: LayoutPath = [],
): ReactNode {
  const {
    desktop,
    workspace,
    sessionInfoById,
    agentUiBySession,
    restoredSnapshotsBySessionId,
    onCloseChrome,
    onToggleMaximize,
    onResize,
    onFocus,
    onSnapshot,
    onApproval,
    onSpawnAdjacent,
    draggingPaneId,
    onDragStartPane,
    onDragEndPane,
    onDropPaneOnEdge,
    onDropPaneOnBody,
  } = ctx;

  const maximizedPaneId = desktop.maximizedPaneId;

  if (node.type === "leaf") {
    const pane = workspace.panes[node.paneId];
    if (!pane) return null;
    if (maximizedPaneId && maximizedPaneId !== pane.id) return null;

    const session = sessionInfoById[pane.sessionId];
    const agent = agentUiBySession[pane.sessionId] ?? emptyAgentSessionState();
    const blocked = agent.pendingApprovals.length > 0;
    const focused = desktop.focusedPaneId === pane.id;
    const status: AgentStatus = deriveAgentStatus(agent, Boolean(agent.finished));
    const taskName = deriveTaskName(session);
    const branch = deriveBranchName(session);
    const agentType = deriveAgentType(session);
    const progressPct = deriveProgressPct(agent);
    const toolCounts = toolCallCount(agent);
    const showInspector =
      toolCounts.total > 0 ||
      agent.fileEdits.length > 0 ||
      agent.widgets.length > 0;

    return (
      <section
        key={pane.id}
        className={`agent-window-shell ${focused ? "is-focused" : ""} ${
          status === "needs_help" ? "is-needs-help" : ""
        }`}
        onMouseDown={() => onFocus(pane.id)}
      >
        <WindowHeader
          taskName={taskName}
          branch={branch}
          agentType={agentType}
          progressPct={progressPct}
          status={status}
          controls={{
            onClose: () => void onCloseChrome(pane.id),
            onMaximize: () => onToggleMaximize(pane.id),
            maximized: maximizedPaneId === pane.id,
          }}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-lastty-pane", pane.id);
            onDragStartPane(pane.id);
          }}
          onDragEnd={onDragEndPane}
        />
        <ProgressBar pct={progressPct} status={status} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: "grid",
            gridTemplateColumns: showInspector ? "minmax(0, 1fr) 320px" : "minmax(0, 1fr)",
            gridTemplateRows: "minmax(0, 1fr)",
          }}
        >
          <TerminalViewport
            blocked={blocked}
            focused={focused}
            onActivate={() => onFocus(pane.id)}
            onSnapshotChange={(snapshot) => onSnapshot(pane.sessionId, snapshot)}
            restoredSnapshot={restoredSnapshotsBySessionId[pane.sessionId] ?? null}
            sessionId={pane.sessionId}
          />
          {showInspector && <AgentInspector agent={agent} />}
        </div>
        {blocked ? (
          <ReplyInput
            approval={agent.pendingApprovals[0]!}
            onSubmit={(choice) =>
              onApproval(pane.sessionId, agent.pendingApprovals[0]!.id, choice)
            }
          />
        ) : (
          <div className="agent-pane-footer">
            <span>
              {toolCounts.root} tool call{toolCounts.root === 1 ? "" : "s"}
              {toolCounts.sub > 0 ? ` (+${toolCounts.sub} subagent)` : ""}
            </span>
            <span>
              {session?.worktree_path ? "isolated" : "shared"} · {agentType}
            </span>
          </div>
        )}
        <EdgeSpawner onSpawn={(direction) => onSpawnAdjacent(pane.id, direction)} />
        {draggingPaneId && draggingPaneId !== pane.id && (
          <PaneDropOverlay
            onDropEdge={(side) => onDropPaneOnEdge(draggingPaneId, pane.id, side)}
            onDropBody={() => onDropPaneOnBody(draggingPaneId, pane.id)}
          />
        )}
      </section>
    );
  }

  const visibleChildren = node.children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => !isLayoutNodeFullyHidden(child, ctx));

  if (visibleChildren.length === 0) return null;

  if (visibleChildren.length === 1) {
    return renderLayout(visibleChildren[0]!.child, ctx, [
      ...path,
      visibleChildren[0]!.index,
    ]);
  }

  const weights = visibleChildren.map(({ index }) => node.weights[index] ?? 1);
  const handleSizePx = 6;
  const template =
    node.direction === "horizontal"
      ? { gridTemplateColumns: buildSplitTemplate(weights, handleSizePx) }
      : { gridTemplateRows: buildSplitTemplate(weights, handleSizePx) };
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  return (
    <div
      style={{
        minHeight: 0,
        height: "100%",
        display: "grid",
        ...template,
      }}
    >
      {visibleChildren.flatMap(({ child, index }, visibleIndex) => {
        const childNode = (
          <div
            key={`${path.join("-") || "root"}-child-${index}`}
            style={{
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {renderLayout(child, ctx, [...path, index])}
          </div>
        );

        if (visibleIndex === visibleChildren.length - 1) {
          return [childNode];
        }

        return [
          childNode,
          <ResizeHandle
            key={`${path.join("-") || "root"}-handle-${index}`}
            direction={node.direction}
            onResize={(delta) => onResize(path, index, delta, node.weights)}
            totalWeight={totalWeight}
          />,
        ];
      })}
    </div>
  );
}

function isLayoutNodeFullyHidden(node: LayoutNode, ctx: RenderLayoutCtx): boolean {
  if (node.type === "leaf") {
    if (ctx.desktop.maximizedPaneId && ctx.desktop.maximizedPaneId !== node.paneId) {
      return true;
    }
    return false;
  }
  return node.children.every((child) => isLayoutNodeFullyHidden(child, ctx));
}

function buildSplitTemplate(weights: number[], handleSizePx: number): string {
  return weights
    .map((weight, index) =>
      index < weights.length - 1 ? `${weight}fr ${handleSizePx}px` : `${weight}fr`,
    )
    .join(" ");
}

function ResizeHandle({
  direction,
  onResize,
  totalWeight,
}: {
  direction: SplitDirection;
  onResize: (delta: number) => void;
  totalWeight: number;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      role="separator"
      className={`agent-split-handle is-${direction}${dragging ? " is-dragging" : ""}`}
      onPointerDown={(event) => {
        const handleElement = event.currentTarget;
        const container = handleElement.parentElement;
        if (!container) return;

        event.preventDefault();
        const startPosition =
          direction === "horizontal" ? event.clientX : event.clientY;
        const extent =
          direction === "horizontal" ? container.clientWidth : container.clientHeight;
        if (extent <= 0 || totalWeight <= 0) return;

        const pointerId = event.pointerId;
        handleElement.setPointerCapture(pointerId);
        setDragging(true);

        const handleMove = (moveEvent: PointerEvent) => {
          const nextPosition =
            direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
          onResize(((nextPosition - startPosition) / extent) * totalWeight);
        };
        const cleanup = () => {
          handleElement.removeEventListener("pointermove", handleMove as EventListener);
          handleElement.removeEventListener("pointerup", cleanup);
          handleElement.removeEventListener("pointercancel", cleanup);
          if (handleElement.hasPointerCapture(pointerId)) {
            handleElement.releasePointerCapture(pointerId);
          }
          setDragging(false);
        };

        handleElement.addEventListener("pointermove", handleMove as EventListener);
        handleElement.addEventListener("pointerup", cleanup);
        handleElement.addEventListener("pointercancel", cleanup);
      }}
    />
  );
}

function PaneDropOverlay({
  onDropEdge,
  onDropBody,
}: {
  onDropEdge: (side: SplitSide) => void;
  onDropBody: () => void;
}) {
  const [hovered, setHovered] = useState<SplitSide | "body" | null>(null);

  const makeEdgeHandlers = (side: SplitSide) => ({
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setHovered(side);
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDragLeave: () => setHovered((current) => (current === side ? null : current)),
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setHovered(null);
      onDropEdge(side);
    },
  });

  const bodyHandlers = {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setHovered("body");
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDragLeave: () => setHovered((current) => (current === "body" ? null : current)),
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setHovered(null);
      onDropBody();
    },
  };

  return (
    <div className="agent-pane-dropzone-layer" aria-hidden>
      <div
        className={`agent-pane-dropzone is-top ${hovered === "top" ? "is-hovered" : ""}`}
        {...makeEdgeHandlers("top")}
      />
      <div
        className={`agent-pane-dropzone is-bottom ${hovered === "bottom" ? "is-hovered" : ""}`}
        {...makeEdgeHandlers("bottom")}
      />
      <div
        className={`agent-pane-dropzone is-left ${hovered === "left" ? "is-hovered" : ""}`}
        {...makeEdgeHandlers("left")}
      />
      <div
        className={`agent-pane-dropzone is-right ${hovered === "right" ? "is-hovered" : ""}`}
        {...makeEdgeHandlers("right")}
      />
      <div
        className={`agent-pane-dropzone is-body ${hovered === "body" ? "is-hovered" : ""}`}
        {...bodyHandlers}
      />
    </div>
  );
}

function EmptyDesktop({ onNewShell }: { onNewShell: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        color: "var(--color-text-secondary)",
        fontFamily: "var(--font-mono)",
        gap: 10,
        padding: 24,
      }}
    >
      <div style={{ fontSize: 12 }}>This desktop has no panes.</div>
      <button
        type="button"
        onClick={onNewShell}
        style={{
          borderRadius: "var(--border-radius-md)",
          border: "0.5px solid var(--color-border-secondary)",
          background: "var(--color-background-secondary)",
          color: "var(--color-text-primary)",
          padding: "6px 12px",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 12,
        }}
      >
        New shell
      </button>
    </div>
  );
}

function AgentInspector({ agent }: { agent: AgentSessionState }) {
  const latestWidget = agent.widgets.at(-1);
  return (
    <aside
      style={{
        borderLeft: "0.5px solid var(--color-border-tertiary)",
        background: "var(--color-background-secondary)",
        color: "var(--color-text-primary)",
        padding: 12,
        overflow: "auto",
        display: "grid",
        gap: 12,
      }}
    >
      <InspectorBlock label="Status">
        <div>{agent.status?.phase ?? "idle"}</div>
        {agent.status?.detail && (
          <div style={{ color: "var(--color-text-secondary)" }}>{agent.status.detail}</div>
        )}
        {agent.progress && (
          <div>
            {agent.progress.pct}% · {agent.progress.message}
          </div>
        )}
      </InspectorBlock>
      {agent.toolCallOrder.length > 0 && (
        <InspectorBlock label="Tool Calls">
          {agent.rootToolCallIds.map((id) => (
            <ToolCallNode
              key={id}
              id={id}
              toolCallsById={agent.toolCallsById}
              childrenByParentId={agent.childrenByParentId}
            />
          ))}
        </InspectorBlock>
      )}
      {agent.fileEdits.length > 0 && (
        <InspectorBlock label="Files Changed">
          {agent.fileEdits.slice(-6).map((file) => (
            <div key={`${file.kind}-${file.path}`}>
              {file.kind.toUpperCase()} {file.path}
            </div>
          ))}
        </InspectorBlock>
      )}
      {latestWidget && (
        <InspectorBlock label={`Widget · ${latestWidget.widgetType}`}>
          <WidgetRenderer widgetType={latestWidget.widgetType} props={latestWidget.props} />
        </InspectorBlock>
      )}
    </aside>
  );
}

function ToolCallNode({
  id,
  toolCallsById,
  childrenByParentId,
}: {
  id: string;
  toolCallsById: Record<string, ToolCallRecord>;
  childrenByParentId: Record<string, string[]>;
}) {
  const call = toolCallsById[id];
  if (!call) return null;
  const children = childrenByParentId[id] ?? [];
  const isSubagent = call.name === "Agent" || call.name === "Task";
  return (
    <div
      style={{
        borderBottom: "0.5px solid var(--color-border-tertiary)",
        paddingBottom: 6,
        paddingLeft: call.depth > 0 ? 10 : 0,
        borderLeft:
          call.depth > 0 ? "1px solid var(--color-border-tertiary)" : undefined,
        marginLeft: call.depth > 0 ? call.depth * 8 : 0,
      }}
    >
      <div>
        {call.depth > 0 && (
          <span style={{ color: "var(--color-text-tertiary)" }}>↳ </span>
        )}
        {isSubagent && (
          <span
            aria-hidden
            style={{ color: "var(--color-text-secondary)", marginRight: 4 }}
          >
            ▸
          </span>
        )}
        {call.name}
      </div>
      <div style={{ color: "var(--color-text-secondary)" }}>
        {JSON.stringify(call.args)}
      </div>
      {call.result !== undefined && (
        <div style={{ color: "var(--color-text-success)" }}>
          {JSON.stringify(call.result)}
        </div>
      )}
      {call.error && (
        <div style={{ color: "var(--color-text-danger)" }}>{call.error}</div>
      )}
      {children.map((childId) => (
        <ToolCallNode
          key={childId}
          id={childId}
          toolCallsById={toolCallsById}
          childrenByParentId={childrenByParentId}
        />
      ))}
    </div>
  );
}

function WidgetRenderer({ widgetType, props }: { widgetType: string; props: unknown }) {
  if (widgetType === "markdown" && typeof props === "object" && props && "content" in props) {
    return <pre style={widgetBodyStyle}>{String((props as { content: unknown }).content)}</pre>;
  }
  if (widgetType === "table" && isTableProps(props)) {
    return (
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {props.headers.map((header) => (
              <th
                key={header}
                style={{
                  textAlign: "left",
                  borderBottom: "0.5px solid var(--color-border-tertiary)",
                  paddingBottom: 6,
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, cellIndex) => (
                <td key={cellIndex} style={{ paddingTop: 6, color: "var(--color-text-primary)" }}>
                  {String(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (widgetType === "json") {
    return <pre style={widgetBodyStyle}>{JSON.stringify(props, null, 2)}</pre>;
  }
  return (
    <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
      Unsupported widget payload
    </div>
  );
}

function LaunchAgentModal({
  agents,
  branchName,
  isolateWorktree,
  launching,
  onBranchNameChange,
  onClose,
  onIsolateWorktreeChange,
  onLaunch,
  onPromptChange,
  onSelectedAgentIdChange,
  prompt,
  selectedAgentId,
}: {
  agents: AgentDefinition[];
  branchName: string;
  isolateWorktree: boolean;
  launching: boolean;
  onBranchNameChange: (value: string) => void;
  onClose: () => void;
  onIsolateWorktreeChange: (value: boolean) => void;
  onLaunch: () => void;
  onPromptChange: (value: string) => void;
  onSelectedAgentIdChange: (value: string) => void;
  prompt: string;
  selectedAgentId: string;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay-scrim)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 40,
      }}
    >
      <div
        style={{
          width: "min(720px, 100%)",
          background: "var(--color-background-primary)",
          color: "var(--color-text-primary)",
          borderRadius: "var(--border-radius-lg)",
          border: "0.5px solid var(--color-border-secondary)",
          padding: 20,
          display: "grid",
          gap: 16,
          boxShadow: "var(--elev-shadow)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div
              style={{
                fontSize: 13,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: "var(--color-text-tertiary)",
              }}
            >
              Launch Agent
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
              registry-backed agents with optional isolated worktrees
            </div>
          </div>
          <ChromeButton label="X" onClick={onClose} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16 }}>
          <div style={{ display: "grid", gap: 8 }}>
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => onSelectedAgentIdChange(agent.id)}
                style={{
                  borderRadius: "var(--border-radius-md)",
                  border:
                    selectedAgentId === agent.id
                      ? "0.5px solid var(--color-border-info)"
                      : "0.5px solid var(--color-border-secondary)",
                  background:
                    selectedAgentId === agent.id
                      ? "var(--color-background-info)"
                      : "var(--color-background-secondary)",
                  color: "var(--color-text-primary)",
                  padding: "10px 12px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                type="button"
              >
                <div>{agent.name}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
                  {agent.command}
                </div>
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Prompt
              <textarea
                onChange={(event) => onPromptChange(event.target.value)}
                rows={6}
                style={textareaStyle}
                value={prompt}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <input
                checked={isolateWorktree}
                onChange={(event) => onIsolateWorktreeChange(event.target.checked)}
                type="checkbox"
              />
              Isolate in git worktree
            </label>
            {isolateWorktree && (
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Branch
                <input
                  onChange={(event) => onBranchNameChange(event.target.value)}
                  style={inputStyle}
                  value={branchName}
                />
              </label>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={onClose} style={secondaryButtonStyle} type="button">
                Cancel
              </button>
              <button
                disabled={!selectedAgentId || launching}
                onClick={onLaunch}
                style={primaryButtonStyle}
                type="button"
              >
                {launching ? "Launching…" : "Launch In New Pane"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToastStack({
  notifications,
  sessionInfoById,
}: {
  notifications: Array<{ sessionId: string; notification: { level: string; message: string } }>;
  sessionInfoById: Record<string, SessionInfo>;
}) {
  if (notifications.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 14,
        right: 14,
        display: "grid",
        gap: 8,
        zIndex: 50,
      }}
    >
      {notifications.slice(-4).map(({ sessionId, notification }, index) => (
        <div
          key={`${sessionId}-${index}-${notification.message}`}
          style={{
            minWidth: 240,
            borderRadius: "var(--border-radius-md)",
            border: "0.5px solid var(--color-border-secondary)",
            background: "var(--color-background-primary)",
            color: "var(--color-text-primary)",
            padding: "8px 10px",
            boxShadow: "var(--elev-shadow)",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
            {sessionInfoById[sessionId]?.title ?? sessionId}
          </div>
          <div style={{ fontSize: 12 }}>{notification.message}</div>
        </div>
      ))}
    </div>
  );
}

function InspectorBlock({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section style={{ display: "grid", gap: 8, fontSize: 12 }}>
      <div
        style={{
          color: "var(--color-text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: 1,
          fontSize: 10,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

function isTableProps(
  props: unknown,
): props is { headers: string[]; rows: Array<Array<string | number | boolean>> } {
  return (
    typeof props === "object" &&
    props !== null &&
    Array.isArray((props as { headers?: unknown }).headers) &&
    Array.isArray((props as { rows?: unknown }).rows)
  );
}

function ChromeButton({
  disabled,
  label,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        borderRadius: "var(--border-radius-sm)",
        border: "0.5px solid var(--color-border-secondary)",
        background: "transparent",
        color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        fontSize: 11,
      }}
      type="button"
    >
      {label}
    </button>
  );
}

const widgetBodyStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  fontSize: 12,
  color: "var(--color-text-primary)",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  borderRadius: "var(--border-radius-md)",
  border: "0.5px solid var(--color-border-secondary)",
  background: "var(--color-background-secondary)",
  color: "var(--color-text-primary)",
  padding: 10,
  resize: "vertical",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: "var(--border-radius-md)",
  border: "0.5px solid var(--color-border-secondary)",
  background: "var(--color-background-secondary)",
  color: "var(--color-text-primary)",
  padding: "8px 10px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
};

const secondaryButtonStyle: CSSProperties = {
  borderRadius: "var(--border-radius-md)",
  border: "0.5px solid var(--color-border-secondary)",
  background: "transparent",
  color: "var(--color-text-primary)",
  padding: "8px 12px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
};

const primaryButtonStyle: CSSProperties = {
  borderRadius: "var(--border-radius-md)",
  border: "0.5px solid var(--color-border-info)",
  background: "var(--color-background-info)",
  color: "var(--color-text-info)",
  padding: "8px 14px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 500,
};
