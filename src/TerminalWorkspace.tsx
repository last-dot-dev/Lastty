import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";

import {
  emptyAgentSessionState,
  parseAgentMessage,
  reduceAgentMessage,
  resolveApproval,
  visibleNotifications,
  type AgentSessionState,
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
import type { TabEntry } from "./components/agent/TabStrip";
import type { BlockedSessionRef } from "./components/agent/AlertBar";
import { useThemeOverride } from "./hooks/useThemeOverride";
import {
  closePane,
  createPaneRecord,
  createWorkspace,
  focusAdjacentPane,
  focusPane,
  renamePane,
  resizeSplit,
  splitPane,
  type LayoutPath,
  type LayoutNode,
  type SplitDirection,
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
import {
  createTerminal,
  getPrimarySessionId,
  killTerminal,
  launchAgent,
  listAgents,
  listSessions,
  respondToApproval,
  restoreTerminalSessions,
  sendKeyEvent,
  updatePaneLayout,
  type AgentDefinition,
  type AgentUiEvent,
  type LaunchAgentResult,
  type PaneLayoutEntry,
  type SessionExitEvent,
  type SessionInfo,
  type SessionTitleEvent,
} from "./lib/ipc";

interface TerminalWorkspaceProps {
  rendererMode: string;
}

export default function TerminalWorkspace({ rendererMode }: TerminalWorkspaceProps) {
  const wgpuMode = rendererMode === "wgpu";
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [sessionInfoById, setSessionInfoById] = useState<Record<string, SessionInfo>>({});
  const [agentUiBySession, setAgentUiBySession] = useState<
    Record<string, AgentSessionState>
  >({});
  const [launcherOpen, setLauncherOpen] = useState(false);
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
  const [minimizedPaneIds, setMinimizedPaneIds] = useState<Set<string>>(new Set());
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);

  const sessionCreationOrder = useMemo(
    () => Object.keys(sessionInfoById),
    [sessionInfoById],
  );

  // wgpu mode: TerminalViewport reports its host rect here; we aggregate and
  // push the whole pane list to Rust with a 16ms trailing debounce so drag
  // resizes don't spam the IPC command.
  const paneRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const pushTimerRef = useRef<number | null>(null);

  const flushPaneLayout = useCallback(() => {
    const entries: PaneLayoutEntry[] = [];
    paneRectsRef.current.forEach((rect, sessionId) => {
      entries.push({
        session_id: sessionId,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    });
    updatePaneLayout(entries).catch((error) => {
      console.error("updatePaneLayout failed", error);
    });
  }, []);

  const schedulePaneLayoutPush = useCallback(() => {
    if (pushTimerRef.current !== null) return;
    pushTimerRef.current = window.setTimeout(() => {
      pushTimerRef.current = null;
      flushPaneLayout();
    }, 16);
  }, [flushPaneLayout]);

  const handlePaneRect = useCallback(
    (sessionId: string, rect: DOMRect | null) => {
      if (rect) {
        paneRectsRef.current.set(sessionId, rect);
      } else {
        paneRectsRef.current.delete(sessionId);
      }
      schedulePaneLayoutPush();
    },
    [schedulePaneLayoutPush],
  );

  // In wgpu mode xterm never mounts, so it can't capture keystrokes. Route
  // them globally to the focused pane's session.
  const focusedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace?.focusedPaneId) {
      focusedSessionIdRef.current = null;
      return;
    }
    focusedSessionIdRef.current =
      workspace.panes[workspace.focusedPaneId]?.sessionId ?? null;
  }, [workspace]);

  useEffect(() => {
    if (!wgpuMode) return;
    const handler = (event: KeyboardEvent) => {
      // Defer to the split/close/launcher chord handler below.
      if (event.ctrlKey && event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const sessionId = focusedSessionIdRef.current;
      if (!sessionId) return;
      event.preventDefault();
      sendKeyEvent(
        event.key,
        event.code,
        event.ctrlKey,
        event.altKey,
        event.shiftKey,
        event.metaKey,
        sessionId,
      ).catch((error) => {
        console.error("sendKeyEvent failed", error);
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wgpuMode]);

  useEffect(() => {
    if (!wgpuMode) return;
    // Scale-factor change: Rust's atlas rebuild keys off the next layout
    // push, so a re-push here is enough to trigger it.
    let unlistenFn: (() => void) | null = null;
    void listen<{ scale_factor: number }>("tauri://scale-change", () => {
      schedulePaneLayoutPush();
    }).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    };
  }, [wgpuMode, schedulePaneLayoutPush]);

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
      if (!event.ctrlKey || !event.shiftKey || !workspace.focusedPaneId) return;
      if (event.key === "H" || event.key === "h") {
        event.preventDefault();
        void handleSplit(workspace.focusedPaneId, "horizontal");
      } else if (event.key === "V" || event.key === "v") {
        event.preventDefault();
        void handleSplit(workspace.focusedPaneId, "vertical");
      } else if (event.key === "W" || event.key === "w") {
        event.preventDefault();
        void handleClose(workspace.focusedPaneId);
      } else if (event.key === "L" || event.key === "l") {
        event.preventDefault();
        setLauncherOpen(true);
      } else if (
        event.key === "ArrowLeft" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowDown"
      ) {
        event.preventDefault();
        const direction =
          event.key === "ArrowLeft"
            ? "left"
            : event.key === "ArrowRight"
              ? "right"
              : event.key === "ArrowUp"
                ? "up"
                : "down";
        setWorkspace((current) => (current ? focusAdjacentPane(current, direction) : current));
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [workspace]);

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
    if (!workspace?.focusedPaneId || !selectedAgentId) return;
    setLaunching(true);
    try {
      const focusedPane = workspace.panes[workspace.focusedPaneId];
      const focusedSession = focusedPane ? sessionInfoById[focusedPane.sessionId] : undefined;
      const result = await launchAgent({
        agent_id: selectedAgentId,
        prompt: agentPrompt || null,
        cwd: focusedSession?.worktree_path ?? null,
        isolate_in_worktree: isolateWorktree,
        branch_name: isolateWorktree ? branchName || null : null,
      });
      applyLaunchedSession(workspace.focusedPaneId, result);
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
    await killTerminal(pane.sessionId).catch((error) => {
      console.error("failed to kill terminal", error);
    });
    setWorkspace((current) => (current ? closePane(current, paneId) : current));
  }

  function handleResizeSplit(
    path: LayoutPath,
    handleIndex: number,
    delta: number,
    baseWeights: number[],
  ) {
    setWorkspace((current) =>
      current ? resizeSplit(current, path, handleIndex, delta, baseWeights) : current,
    );
  }

  function upsertSession(session: SessionInfo) {
    setSessionInfoById((current) => ({
      ...current,
      [session.session_id]: session,
    }));
  }

  function minimizePane(paneId: string) {
    setMinimizedPaneIds((current) => {
      if (current.has(paneId)) return current;
      const next = new Set(current);
      next.add(paneId);
      return next;
    });
    if (maximizedPaneId === paneId) {
      setMaximizedPaneId(null);
    }
  }

  function toggleMaximizePane(paneId: string) {
    setMaximizedPaneId((current) => (current === paneId ? null : paneId));
    setMinimizedPaneIds((current) => {
      if (!current.has(paneId)) return current;
      const next = new Set(current);
      next.delete(paneId);
      return next;
    });
  }

  function restoreFromTab(paneId: string) {
    setMinimizedPaneIds((current) => {
      if (!current.has(paneId)) return current;
      const next = new Set(current);
      next.delete(paneId);
      return next;
    });
    setMaximizedPaneId((current) => (current && current !== paneId ? null : current));
    setWorkspace((current) => (current ? focusPane(current, paneId) : current));
  }

  async function handleCloseFromChrome(paneId: string) {
    setMinimizedPaneIds((current) => {
      if (!current.has(paneId)) return current;
      const next = new Set(current);
      next.delete(paneId);
      return next;
    });
    setMaximizedPaneId((current) => (current === paneId ? null : current));
    await handleClose(paneId);
  }

  function handleJumpToBlocked(sessionId: string) {
    if (!workspace) return;
    const pane = Object.values(workspace.panes).find(
      (entry) => entry.sessionId === sessionId,
    );
    if (!pane) return;
    restoreFromTab(pane.id);
    setWorkspace((current) => (current ? focusPane(current, pane.id) : current));
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
          focused: pane?.id === workspace.focusedPaneId,
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

  const tabEntries: TabEntry[] = workspace
    ? (() => {
        const panes = Object.values(workspace.panes);
        const minimized = panes
          .filter((pane) => minimizedPaneIds.has(pane.id))
          .map((pane) => ({ pane, reason: "minimized" as const }));
        const displaced =
          maximizedPaneId && workspace.panes[maximizedPaneId]
            ? panes
                .filter(
                  (pane) =>
                    pane.id !== maximizedPaneId && !minimizedPaneIds.has(pane.id),
                )
                .map((pane) => ({ pane, reason: "displaced" as const }))
            : [];
        return [...minimized, ...displaced].map(({ pane, reason }) => {
          const info = sessionInfoById[pane.sessionId];
          const ui = agentUiBySession[pane.sessionId];
          const status = deriveAgentStatus(ui, Boolean(ui?.finished));
          return {
            paneId: pane.id,
            sessionId: pane.sessionId,
            taskName: deriveTaskName(info),
            progressPct: deriveProgressPct(ui),
            status,
            color: assignBranchColor(pane.sessionId, sessionCreationOrder),
            reason,
          };
        });
      })()
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
        tabs={tabEntries}
        onRestoreTab={restoreFromTab}
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
          {renderLayout(workspace.layout, {
            workspace,
            sessionInfoById,
            agentUiBySession,
            restoredSnapshotsBySessionId,
            minimizedPaneIds,
            maximizedPaneId,
            rendererMode,
            onPaneRect: handlePaneRect,
            onCloseChrome: handleCloseFromChrome,
            onMinimize: minimizePane,
            onToggleMaximize: toggleMaximizePane,
            onResize: handleResizeSplit,
            onFocus: (paneId) =>
              setWorkspace((current) => (current ? focusPane(current, paneId) : current)),
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
      <ToastStack notifications={toastNotifications} sessionInfoById={sessionInfoById} />
    </div>
  );
}

interface RenderLayoutCtx {
  workspace: WorkspaceState;
  sessionInfoById: Record<string, SessionInfo>;
  agentUiBySession: Record<string, AgentSessionState>;
  restoredSnapshotsBySessionId: Record<string, PersistedTerminalSnapshot>;
  minimizedPaneIds: Set<string>;
  maximizedPaneId: string | null;
  rendererMode: string;
  onPaneRect: (sessionId: string, rect: DOMRect | null) => void;
  onCloseChrome: (paneId: string) => Promise<void>;
  onMinimize: (paneId: string) => void;
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
}

function renderLayout(
  node: LayoutNode,
  ctx: RenderLayoutCtx,
  path: LayoutPath = [],
): ReactNode {
  const {
    workspace,
    sessionInfoById,
    agentUiBySession,
    restoredSnapshotsBySessionId,
    minimizedPaneIds,
    maximizedPaneId,
    rendererMode,
    onPaneRect,
    onCloseChrome,
    onMinimize,
    onToggleMaximize,
    onResize,
    onFocus,
    onSnapshot,
    onApproval,
    onSpawnAdjacent,
  } = ctx;

  if (node.type === "leaf") {
    const pane = workspace.panes[node.paneId];
    if (!pane) return null;
    if (minimizedPaneIds.has(pane.id)) return null;
    if (maximizedPaneId && maximizedPaneId !== pane.id) return null;

    const session = sessionInfoById[pane.sessionId];
    const agent = agentUiBySession[pane.sessionId] ?? emptyAgentSessionState();
    const blocked = agent.pendingApprovals.length > 0;
    const focused = workspace.focusedPaneId === pane.id;
    const status: AgentStatus = deriveAgentStatus(agent, Boolean(agent.finished));
    const taskName = deriveTaskName(session);
    const branch = deriveBranchName(session);
    const agentType = deriveAgentType(session);
    const progressPct = deriveProgressPct(agent);
    const showInspector =
      agent.toolCalls.length > 0 ||
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
            onMinimize: () => onMinimize(pane.id),
            onMaximize: () => onToggleMaximize(pane.id),
            maximized: maximizedPaneId === pane.id,
          }}
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
            onRectChange={onPaneRect}
            rendererMode={rendererMode}
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
            <span>{agent.toolCalls.length} tool calls</span>
            <span>
              {session?.worktree_path ? "isolated" : "shared"} · {agentType}
            </span>
          </div>
        )}
        <EdgeSpawner onSpawn={(direction) => onSpawnAdjacent(pane.id, direction)} />
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
    if (ctx.minimizedPaneIds.has(node.paneId)) return true;
    if (ctx.maximizedPaneId && ctx.maximizedPaneId !== node.paneId) return true;
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
      {agent.toolCalls.length > 0 && (
        <InspectorBlock label="Tool Calls">
          {agent.toolCalls.slice(-6).map((call) => (
            <div
              key={call.id}
              style={{
                borderBottom: "0.5px solid var(--color-border-tertiary)",
                paddingBottom: 6,
              }}
            >
              <div>{call.name}</div>
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
            </div>
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
