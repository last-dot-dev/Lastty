import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";

import KeyboardHelpOverlay from "./components/KeyboardHelpOverlay";
import SettingsPanel from "./components/SettingsPanel";
import UpdateBadge from "./components/UpdateBadge";
import {
  detectPlatform,
  matchBinding,
  type PendingBinding,
} from "./app/keybindings";

import { parseAgentMessage, toolCallCount } from "./app/agentUi";
import {
  useAgentStore,
  useAgentSession,
  useBlockedSessionIds,
} from "./app/agentStore";
import { AgentInspector } from "./components/agent/AgentInspector";
import { NotificationToasts } from "./components/agent/NotificationToasts";
import { ChatPanel } from "./components/peer/ChatPanel";
import { usePeerStore } from "./app/peerStore";
import type { PeerMessageEvent, PeerPresenceEvent } from "./app/peerTypes";
import {
  deriveAgentStatus,
  deriveAgentType,
  deriveProgressPct,
  deriveTaskName,
  type AgentStatus,
} from "./app/agentDerived";
import AgentShell from "./components/agent/AgentShell";
import HistoryPanel from "./components/agent/HistoryPanel";
import TranscriptView from "./components/agent/TranscriptView";
import WindowHeader from "./components/agent/WindowHeader";
import PaneFooter from "./components/agent/PaneFooter";
import ProgressBar from "./components/agent/ProgressBar";
import ReplyInput from "./components/agent/ReplyInput";
import EdgeSpawner, { type SpawnDirection } from "./components/agent/EdgeSpawner";
import type { WorktreeRow } from "./components/agent/WorktreeList";
import MergeDialog from "./components/agent/MergeDialog";
import type { DesktopEntry } from "./components/agent/DesktopStrip";
import type { BlockedSessionRef } from "./components/agent/AlertBar";
import { useThemeOverride } from "./hooks/useThemeOverride";
import { useKeyboardMode } from "./hooks/useKeyboardMode";
import { useLastAgent } from "./hooks/useLastAgent";
import {
  activeDesktop,
  attachPaneToDesktop,
  closeDesktop,
  closePane,
  createDesktop,
  createPaneRecord,
  createWorkspace,
  setDesktopProjectRoot,
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
  collectPaneRects,
  collectSplitHandles,
  type DesktopState,
  type LayoutPath,
  type PaneRect,
  type SplitDirection,
  type SplitHandleInfo,
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
  getBenchmarkMode,
  getPrimarySessionId,
  getWorkspaceRoot,
  gitGraph,
  isGitRepo,
  killTerminal,
  launchAgent,
  listAgents,
  listSessions,
  listWorktrees,
  respondToApproval,
  restoreTerminalSessions,
  worktreeStatus,
  type AgentDefinition,
  type AgentUiEvent,
  type GitGraph,
  type SessionExitEvent,
  type HistoryEntry,
  type SessionInfo,
  type SessionTitleEvent,
  type Worktree,
  type WorktreeStatus,
  type WorktreeStrategy,
  abandonWorktree,
  pruneLocalIfClean,
  resumeHistoryEntry,
} from "./lib/ipc";
import { layoutGraph } from "./lib/graphLayout";
import type { SidebarGraph } from "./components/agent/Sidebar";
import { useStressDriver } from "./app/stressDriver";

function basenameOfPath(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

function pathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

interface DesktopCell {
  left: number;
  top: number;
  width: number;
  height: number;
}

function computeDesktopCells(n: number): DesktopCell[] {
  if (n <= 0) return [];
  if (n === 1) return [{ left: 0.09, top: 0.09, width: 0.82, height: 0.82 }];
  const cols = n === 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : n <= 9 ? 3 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const padding = 0.04;
  const gap = 0.02;
  const cellW = (1 - 2 * padding - (cols - 1) * gap) / cols;
  const cellH = (1 - 2 * padding - (rows - 1) * gap) / rows;
  return Array.from({ length: n }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      left: padding + col * (cellW + gap),
      top: padding + row * (cellH + gap),
      width: cellW,
      height: cellH,
    };
  });
}

function SettingsIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.1" />
      <path d="M12 19.1v2.1" />
      <path d="m4.8 4.8 1.5 1.5" />
      <path d="m17.7 17.7 1.5 1.5" />
      <path d="M2.8 12h2.1" />
      <path d="M19.1 12h2.1" />
      <path d="m4.8 19.2 1.5-1.5" />
      <path d="m17.7 6.3 1.5-1.5" />
    </svg>
  );
}

export default function TerminalWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [sessionInfoById, setSessionInfoById] = useState<Record<string, SessionInfo>>({});
  const focusedSessionIdRef = useRef<string | null>(null);
  const [draftPaneIds, setDraftPaneIds] = useState<Set<string>>(() => new Set());
  const [draftSeedByPaneId, setDraftSeedByPaneId] = useState<Record<string, string>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [exposeMode, setExposeMode] = useState(false);
  const platform = useMemo(() => detectPlatform(), []);
  const pendingBindingRef = useRef<PendingBinding[]>([]);
  const [launching, setLaunching] = useState(false);
  const [autoPromoteNotice, setAutoPromoteNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!autoPromoteNotice) return;
    const handle = window.setTimeout(() => setAutoPromoteNotice(null), 6000);
    return () => window.clearTimeout(handle);
  }, [autoPromoteNotice]);
  const [clock, setClock] = useState(Date.now());
  const [hydrated, setHydrated] = useState(false);
  const [benchMode, setBenchMode] = useState<string | null>(null);
  const [terminalSnapshotsBySessionId, setTerminalSnapshotsBySessionId] = useState<
    Record<string, PersistedTerminalSnapshot>
  >({});
  const [restoredSnapshotsBySessionId, setRestoredSnapshotsBySessionId] = useState<
    Record<string, PersistedTerminalSnapshot>
  >({});
  type GraphEntry =
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "ready"; graph: GitGraph };
  const [graphByCwd, setGraphByCwd] = useState<Record<string, GraphEntry>>({});
  type WorktreesEntry =
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "ready"; worktrees: Worktree[] };
  const [worktreesByRepo, setWorktreesByRepo] = useState<Record<string, WorktreesEntry>>({});
  const [statusByWorktreePath, setStatusByWorktreePath] = useState<
    Record<string, WorktreeStatus>
  >({});
  const [mergedWorktreePaths, setMergedWorktreePaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [worktreesReloadCounter, setWorktreesReloadCounter] = useState(0);
  const loadedWorktreeRepoRootsRef = useRef<Set<string>>(new Set());
  const [mergeDialog, setMergeDialog] = useState<
    { focusPath: string | null } | null
  >(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getWorkspaceRoot()
      .then((root) => {
        if (!cancelled) setWorkspaceRoot(root);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useStressDriver({
    workspace,
    setWorkspace,
    hydrated,
    hydrateSessionInfo: (sessionId, fallbackTitle) =>
      hydrateSessionInfo(sessionId, fallbackTitle).then(() => undefined),
  });

  const [historyPanelPaneId, setHistoryPanelPaneId] = useState<string | null>(null);
  const [viewingHistoryByPaneId, setViewingHistoryByPaneId] = useState<
    Record<string, HistoryEntry>
  >({});
  const sessionCreationOrder = useMemo(
    () => Object.keys(sessionInfoById),
    [sessionInfoById],
  );

  const currentDesktop: DesktopState | null = workspace ? activeDesktop(workspace) : null;
  const focusedPaneId = currentDesktop?.focusedPaneId ?? null;
  const focusedSessionId = useMemo(() => {
    if (!workspace || !focusedPaneId) return null;
    return workspace.panes[focusedPaneId]?.sessionId ?? null;
  }, [workspace, focusedPaneId]);
  useEffect(() => {
    focusedSessionIdRef.current = focusedSessionId;
  }, [focusedSessionId]);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);

  useEffect(() => {
    if (!draggingPaneId) return;
    const clear = () => setDraggingPaneId(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, [draggingPaneId]);

  const activeProjectRoot = useMemo(() => {
    if (!workspace) return workspaceRoot;
    return activeDesktop(workspace).projectRoot || workspaceRoot;
  }, [workspace, workspaceRoot]);

  useEffect(() => {
    if (!activeProjectRoot) return;
    let cancelled = false;
    setGraphByCwd((current) =>
      current[activeProjectRoot]
        ? current
        : { ...current, [activeProjectRoot]: { state: "loading" } },
    );
    void gitGraph(activeProjectRoot)
      .then((graph) => {
        if (cancelled) return;
        setGraphByCwd((current) => ({
          ...current,
          [activeProjectRoot]: { state: "ready", graph },
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error("git_graph failed for", activeProjectRoot, error);
        setGraphByCwd((current) => ({
          ...current,
          [activeProjectRoot]: { state: "error", message },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectRoot]);

  const nonGitPromptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated || !workspace) return;
    if (benchMode === "stress") return;
    if (!activeProjectRoot) return;
    if (nonGitPromptedRef.current.has(activeProjectRoot)) return;
    const desktopId = workspace.activeDesktopId;
    nonGitPromptedRef.current.add(activeProjectRoot);
    void isGitRepo(activeProjectRoot).then((isRepo) => {
      if (isRepo) return;
      void handleChangeProjectRoot(desktopId);
    });
  }, [hydrated, workspace, activeProjectRoot, benchMode]);

  useEffect(() => {
    if (!activeProjectRoot) return;
    if (loadedWorktreeRepoRootsRef.current.has(activeProjectRoot)) return;
    loadedWorktreeRepoRootsRef.current.add(activeProjectRoot);
    let cancelled = false;
    setWorktreesByRepo((current) => ({
      ...current,
      [activeProjectRoot]: { state: "loading" },
    }));
    void listWorktrees(activeProjectRoot)
      .then((worktrees) => {
        if (cancelled) return;
        setWorktreesByRepo((current) => ({
          ...current,
          [activeProjectRoot]: { state: "ready", worktrees },
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setWorktreesByRepo((current) => ({
          ...current,
          [activeProjectRoot]: { state: "error", message },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectRoot, worktreesReloadCounter]);

  useEffect(() => {
    if (!activeProjectRoot) return;
    const entry = worktreesByRepo[activeProjectRoot];
    if (!entry || entry.state !== "ready") return;
    const worktrees = entry.worktrees;
    const mainBranch =
      worktrees.find((w) => w.is_main)?.branch || "main";

    let cancelled = false;
    function fetchAll() {
      for (const wt of worktrees) {
        void worktreeStatus(wt.path, mainBranch)
          .then((status) => {
            if (cancelled) return;
            setStatusByWorktreePath((current) => ({
              ...current,
              [wt.path]: status,
            }));
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            console.error("worktree_status failed", wt.path, error);
          });
      }
    }

    fetchAll();
    const timer = window.setInterval(fetchAll, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeProjectRoot, worktreesByRepo]);

  function reloadWorktrees() {
    if (!activeProjectRoot) return;
    loadedWorktreeRepoRootsRef.current.delete(activeProjectRoot);
    setWorktreesReloadCounter((n) => n + 1);
  }

  function invalidateWorktreeStatus(path: string) {
    setStatusByWorktreePath((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  async function handleAbandonWorktree(worktreePath: string) {
    if (!activeProjectRoot) return;
    const label = basenameOfPath(worktreePath) || worktreePath;
    const ok = window.confirm(
      `Abandon "${label}"?\n\nThis will close the GitHub PR (if any), delete the remote + local branch, and remove the worktree directory.`,
    );
    if (!ok) return;
    try {
      await abandonWorktree(worktreePath, activeProjectRoot);
    } catch (error) {
      console.error("abandon_worktree failed", error);
      window.alert(
        `Failed to abandon worktree: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    invalidateWorktreeStatus(worktreePath);
    reloadWorktrees();
  }

  const sidebarGraph = useMemo<SidebarGraph>(() => {
    if (!activeProjectRoot) return { state: "idle", reason: "no repo" };
    const entry = graphByCwd[activeProjectRoot];
    if (!entry) return { state: "loading" };
    if (entry.state !== "ready") return entry;
    return {
      state: "ready",
      layout: layoutGraph(entry.graph.commits),
      headSha: entry.graph.head,
      headRef: entry.graph.head_ref,
    };
  }, [activeProjectRoot, graphByCwd]);

  const theme = useThemeOverride();
  const keyboardMode = useKeyboardMode();
  const { lastAgentId, setLastAgentId } = useLastAgent();
  const resolvedLastAgentId =
    lastAgentId === "shell" || agents.some((a) => a.id === lastAgentId)
      ? lastAgentId
      : null;

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

        const mode = await getBenchmarkMode().catch(() => null);
        if (!cancelled) setBenchMode(mode);
        const persisted = mode === "stress" ? null : readPersistedWorkspaceState();
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

        const bootstrapSession = sessions.find(
          (session) => session.session_id === sessionId,
        );
        const sessionTitle = bootstrapSession?.title || "shell";
        const bootstrapRoot =
          bootstrapSession?.cwd || (await getWorkspaceRoot().catch(() => "")) || "";
        setWorkspace((current) =>
          current ??
            createWorkspace(
              createPaneRecord(sessionId, sessionTitle),
              bootstrapRoot,
            ),
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
        const info = sessionInfoById[firstSessionId];
        setWorkspace(
          createWorkspace(
            createPaneRecord(firstSessionId, info?.title || "shell"),
            info?.cwd || workspaceRoot || "",
          ),
        );
      }
    }
  }, [sessionInfoById, workspace, workspaceRoot]);

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
      setSessionInfoById((current) => {
        if (!current[event.payload.session_id]) {
          void hydrateSessionInfo(
            event.payload.session_id,
            event.payload.title || "shell",
          );
        }
        return {
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
              started_at_unix_ms: 0,
            }),
            title: event.payload.title || "shell",
          },
        };
      });
    }).then((fn) => unsubs.push(fn));

    void listen<SessionExitEvent>("session:exit", (event) => {
      cleanupClosedSession(event.payload.session_id);
    }).then((fn) => unsubs.push(fn));

    void listen<AgentUiEvent>("agent:ui", (event) => {
      const message = parseAgentMessage(event.payload.message);
      if (!message) return;
      useAgentStore.getState().ingest(event.payload.session_id, message);
    }).then((fn) => unsubs.push(fn));

    void listen<unknown>("bus:event", (event) => {
      const payload = event.payload as { type?: unknown } | null;
      const kind = payload && typeof payload === "object" ? payload.type : undefined;
      if (kind === "peer_message") {
        usePeerStore.getState().ingestMessage(payload as PeerMessageEvent);
      } else if (kind === "peer_presence") {
        usePeerStore.getState().ingestPresence(payload as PeerPresenceEvent);
      }
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
      if (helpOpen || settingsOpen) return;

      const target = event.target as Element | null;
      const typingInField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (!typingInField) {
        const meta = event.metaKey || event.ctrlKey;
        if (event.key === "\\" || (meta && event.key === "/")) {
          event.preventDefault();
          event.stopPropagation();
          setExposeMode((open) => !open);
          return;
        }
        if (event.key === "Escape" && exposeMode) {
          event.preventDefault();
          event.stopPropagation();
          setExposeMode(false);
          return;
        }
      }

      const resolution = matchBinding(
        event,
        platform,
        keyboardMode.mode,
        pendingBindingRef.current,
      );
      pendingBindingRef.current = resolution.pending;
      if (resolution.capture) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!resolution.match) {
        return;
      }
      const { binding } = resolution.match;
      const activePaneId = activeDesktop(workspace).focusedPaneId;

      switch (binding.id) {
        case "help.toggle":
          setHelpOpen((open) => !open);
          return;
        case "desktop.new":
          void handleNewDesktop();
          return;
        case "desktop.next":
          handleCycleDesktop(1);
          return;
        case "desktop.prev":
          handleCycleDesktop(-1);
          return;
        case "desktop.jump":
          if (binding.payload === undefined) return;
          handleJumpToDesktopIndex(binding.payload - 1);
          return;
        case "focus.left":
        case "focus.down":
        case "focus.up":
        case "focus.right": {
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
          void handleSplit(activePaneId, "horizontal");
          return;
        case "pane.split.vertical":
          if (!activePaneId) return;
          void handleSplit(activePaneId, "vertical");
          return;
        case "pane.close":
          if (!activePaneId) return;
          void handleClose(activePaneId);
          return;
        case "agent.launch":
          createDraftPane({ kind: "focused" });
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [workspace, platform, keyboardMode.mode, helpOpen, settingsOpen, exposeMode]);

  useEffect(() => {
    const clearPending = () => {
      pendingBindingRef.current = [];
    };
    window.addEventListener("blur", clearPending);
    return () => window.removeEventListener("blur", clearPending);
  }, []);

  useEffect(() => {
    pendingBindingRef.current = [];
  }, [helpOpen, settingsOpen, keyboardMode.mode]);

  async function handleSplit(paneId: string, direction: SplitDirection) {
    const desktop = workspace ? findDesktopForPane(workspace, paneId) : null;
    const cwd = desktop?.projectRoot || undefined;
    const sessionId = await createTerminal(cwd);
    await hydrateSessionInfo(
      sessionId,
      `shell ${Object.keys(sessionInfoById).length + 1}`,
    );
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

  async function handleAttachToWorktree(
    worktreePath: string,
    choice: "shell" | { agentId: string },
  ) {
    if (!workspace) return;
    const desktop = activeDesktop(workspace);
    const activePaneId = desktop.focusedPaneId;
    if (!activePaneId) return;
    const isMainRow = pathsEqual(worktreePath, activeProjectRoot);
    try {
      if (choice === "shell") {
        const sessionId = await createTerminal(worktreePath);
        const label = basenameOfPath(worktreePath) || "shell";
        await hydrateSessionInfo(sessionId, label);
        setWorkspace((current) => {
          if (!current) return current;
          return splitPane(
            current,
            activePaneId,
            "vertical",
            createPaneRecord(sessionId, label),
          );
        });
      } else {
        const result = await launchAgent({
          agent_id: choice.agentId,
          cwd: worktreePath,
          worktree: isMainRow
            ? { kind: "in_place" }
            : { kind: "attach", path: worktreePath },
        });
        if (result.auto_promoted) {
          setAutoPromoteNotice(
            `another agent is running here — created ${basenameOfPath(
              result.worktree_path ?? "",
            )} to isolate`,
          );
        }
        upsertSession({
          session_id: result.session_id,
          title: result.pane_title,
          agent_id: choice.agentId,
          cwd: result.cwd,
          prompt: null,
          prompt_summary: null,
          worktree_path: result.worktree_path ?? null,
          control_connected: false,
          started_at_ms: Date.now(),
          started_at_unix_ms: Date.now(),
        });
        setWorkspace((current) => {
          if (!current) return current;
          return splitPane(
            current,
            activePaneId,
            "vertical",
            createPaneRecord(result.session_id, result.pane_title),
          );
        });
      }
      invalidateWorktreeStatus(worktreePath);
      reloadWorktrees();
    } catch (error) {
      console.error("attach to worktree failed", error);
    }
  }

  async function handleLaunchAgent(
    draftId: string,
    config: {
      agentId: string;
      prompt: string;
      worktreeChoice: string;
      launchCount: number;
      branchName: string;
    },
  ) {
    if (!workspace || !config.agentId) return;
    setLastAgentId(config.agentId);
    const desktop = activeDesktop(workspace);
    setLaunching(true);
    try {
      const count = Math.max(1, Math.min(5, config.launchCount));
      const isolate = config.worktreeChoice === "new";
      const inPlace = config.worktreeChoice === "in_place";
      const attachPath = isolate || inPlace ? null : config.worktreeChoice;
      let anchorPaneId: string = draftId;
      for (let i = 0; i < count; i += 1) {
        let newSessionId: string;
        let newTitle: string;
        if (config.agentId === "shell") {
          const cwd = attachPath || desktop.projectRoot || undefined;
          newSessionId = await createTerminal(cwd);
          newTitle = basenameOfPath(cwd || "") || "shell";
          await hydrateSessionInfo(newSessionId, newTitle);
        } else {
          const worktree: WorktreeStrategy = isolate
            ? {
                kind: "new",
                branch:
                  count === 1 && config.branchName ? config.branchName : null,
              }
            : attachPath
              ? { kind: "attach", path: attachPath }
              : { kind: "in_place" };
          const result = await launchAgent({
            agent_id: config.agentId,
            prompt: config.prompt || null,
            cwd: attachPath || desktop.projectRoot || null,
            worktree,
          });
          if (result.auto_promoted) {
            setAutoPromoteNotice(
              `another agent is running here — created ${basenameOfPath(
                result.worktree_path ?? "",
              )} to isolate`,
            );
          }
          upsertSession({
            session_id: result.session_id,
            title: result.pane_title,
            agent_id: config.agentId,
            cwd: result.cwd,
            prompt: config.prompt || null,
            prompt_summary: config.prompt || null,
            worktree_path: result.worktree_path ?? null,
            control_connected: false,
            started_at_ms: 0,
            started_at_unix_ms: 0,
          });
          newSessionId = result.session_id;
          newTitle = result.pane_title;
        }
        if (i === 0) {
          setWorkspace((current) => {
            if (!current || !(draftId in current.panes)) return current;
            return {
              ...current,
              panes: {
                ...current.panes,
                [draftId]: {
                  ...current.panes[draftId],
                  sessionId: newSessionId,
                  title: newTitle,
                },
              },
            };
          });
        } else {
          const paneRecord = createPaneRecord(newSessionId, newTitle);
          setWorkspace((current) => {
            if (!current || !(anchorPaneId in current.panes)) return current;
            return splitPane(current, anchorPaneId, "vertical", paneRecord);
          });
        }
      }
      setDraftPaneIds((prev) => {
        if (!prev.has(draftId)) return prev;
        const next = new Set(prev);
        next.delete(draftId);
        return next;
      });
      setDraftSeedByPaneId((prev) => {
        if (!(draftId in prev)) return prev;
        const next = { ...prev };
        delete next[draftId];
        return next;
      });
      reloadWorktrees();
    } catch (error) {
      console.error("failed to launch agent", error);
      window.alert(`Failed to launch agent: ${error}`);
    } finally {
      setLaunching(false);
    }
  }

  function createDraftPane(
    anchor:
      | { kind: "split"; paneId: string; direction: SplitDirection }
      | { kind: "root"; desktopId: string }
      | { kind: "focused" },
    agentSeed?: string,
  ) {
    const draftSessionId = `draft-${crypto.randomUUID()}`;
    const paneRecord = createPaneRecord(draftSessionId, "new terminal");
    setWorkspace((current) => {
      if (!current) return current;
      if (anchor.kind === "root") {
        return {
          ...current,
          panes: { ...current.panes, [paneRecord.id]: paneRecord },
          desktops: current.desktops.map((d) =>
            d.id === anchor.desktopId
              ? {
                  ...d,
                  layout: { type: "leaf", paneId: paneRecord.id },
                  focusedPaneId: paneRecord.id,
                }
              : d,
          ),
        };
      }
      const anchorPaneId =
        anchor.kind === "split"
          ? anchor.paneId
          : activeDesktop(current).focusedPaneId;
      if (!anchorPaneId || !(anchorPaneId in current.panes)) return current;
      const direction: SplitDirection =
        anchor.kind === "split" ? anchor.direction : "vertical";
      return splitPane(current, anchorPaneId, direction, paneRecord);
    });
    setDraftPaneIds((prev) => {
      const next = new Set(prev);
      next.add(paneRecord.id);
      return next;
    });
    if (agentSeed) {
      setDraftSeedByPaneId((prev) => ({ ...prev, [paneRecord.id]: agentSeed }));
    }
  }

  function cancelDraftPane(paneId: string) {
    setDraftPaneIds((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.delete(paneId);
      return next;
    });
    setDraftSeedByPaneId((prev) => {
      if (!(paneId in prev)) return prev;
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
    setWorkspace((current) => {
      if (!current || !(paneId in current.panes)) return current;
      const ownerDesktop = findDesktopForPane(current, paneId);
      return closePane(
        current,
        paneId,
        ownerDesktop?.id ?? current.activeDesktopId,
      );
    });
  }

  async function handleClose(paneId: string) {
    const pane = workspace?.panes[paneId];
    if (!pane) return;
    const sessionId = pane.sessionId;
    const info = sessionInfoById[sessionId];
    const worktreePath = info?.worktree_path;
    const entry = activeProjectRoot
      ? worktreesByRepo[activeProjectRoot]
      : undefined;
    const isLasttyWorktree = Boolean(
      worktreePath &&
        entry?.state === "ready" &&
        entry.worktrees.find((w) => w.path === worktreePath)?.is_lastty,
    );
    if (worktreePath) {
      const status = statusByWorktreePath[worktreePath];
      const dirty = status?.uncommitted_files ?? 0;
      if (dirty > 0) {
        const label = basenameOfPath(worktreePath) || worktreePath;
        const ok = window.confirm(
          `"${label}" has ${dirty} uncommitted file${
            dirty === 1 ? "" : "s"
          }.\n\nClosing this pane will stop the agent. The worktree directory is kept on disk so your work isn't lost — open it in your editor or reattach a pane to recover.\n\nClose anyway?`,
        );
        if (!ok) return;
      }
    }
    await killTerminal(sessionId).catch((error) => {
      console.error("failed to kill terminal", error);
    });
    cleanupClosedSession(sessionId);
    setViewingHistoryByPaneId((current) => {
      if (!(paneId in current)) return current;
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setHistoryPanelPaneId((current) => (current === paneId ? null : current));
    if (worktreePath && isLasttyWorktree && activeProjectRoot) {
      void pruneLocalIfClean(worktreePath, activeProjectRoot, "main")
        .then((removed) => {
          if (removed) {
            invalidateWorktreeStatus(worktreePath);
            reloadWorktrees();
          }
        })
        .catch((error) => {
          console.warn("auto-prune failed", error);
        });
    }
  }

  function handleToggleHistoryPanel(paneId: string) {
    setHistoryPanelPaneId((current) => (current === paneId ? null : paneId));
  }

  function handleCloseHistoryPanel() {
    setHistoryPanelPaneId(null);
  }

  async function hydrateSessionInfo(sessionId: string, fallbackTitle: string) {
    try {
      const sessions = await listSessions();
      const info = sessions.find((s) => s.session_id === sessionId);
      if (info) {
        upsertSession(info);
        return info;
      }
    } catch (error) {
      console.error("failed to hydrate session info", error);
    }
    const placeholder: SessionInfo = {
      session_id: sessionId,
      title: fallbackTitle,
      cwd: "",
      prompt: null,
      agent_id: null,
      prompt_summary: null,
      worktree_path: null,
      control_connected: false,
      started_at_ms: 0,
      started_at_unix_ms: 0,
    };
    upsertSession(placeholder);
    return placeholder;
  }

  async function handleResumeHistoryEntry(paneId: string, entry: HistoryEntry) {
    console.log("[resume] handler entry", {
      paneId,
      session_id: entry.session_id,
      agent_id: entry.agent_id,
      agent_session_id: entry.agent_session_id,
    });
    setHistoryPanelPaneId(null);
    setViewingHistoryByPaneId((current) => {
      if (!(paneId in current)) return current;
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    try {
      const result = await resumeHistoryEntry(entry.session_id);
      console.log("[resume] ipc result", result);
      const sessions = await listSessions();
      const info = sessions.find((s) => s.session_id === result.session_id);
      if (info) upsertSession(info);
      setWorkspace((current) => {
        if (!current) {
          console.warn("[resume] workspace null, skipping swap");
          return current;
        }
        const pane = current.panes[paneId];
        if (!pane) {
          console.warn("[resume] pane missing, skipping swap", paneId);
          return current;
        }
        console.log("[resume] swap committed", {
          paneId,
          old: pane.sessionId,
          new: result.session_id,
        });
        return {
          ...current,
          panes: {
            ...current.panes,
            [paneId]: { ...pane, sessionId: result.session_id },
          },
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("failed to resume history entry", message);
      window.alert(`Couldn't resume that conversation:\n\n${message}`);
    }
  }

  function handleViewHistoryTranscript(paneId: string, entry: HistoryEntry) {
    setHistoryPanelPaneId(null);
    setViewingHistoryByPaneId((current) => ({ ...current, [paneId]: entry }));
  }

  function handleCloseHistoryView(paneId: string) {
    setViewingHistoryByPaneId((current) => {
      if (!(paneId in current)) return current;
      const next = { ...current };
      delete next[paneId];
      return next;
    });
  }

  function upsertSession(session: SessionInfo) {
    setSessionInfoById((current) => ({
      ...current,
      [session.session_id]: session,
    }));
  }

  function cleanupClosedSession(sessionId: string) {
    releaseTerminalHost(sessionId);
    const dropKey = <V,>(map: Record<string, V>): Record<string, V> => {
      if (!(sessionId in map)) return map;
      const next = { ...map };
      delete next[sessionId];
      return next;
    };
    setSessionInfoById(dropKey);
    useAgentStore.getState().forgetSession(sessionId);
    setTerminalSnapshotsBySessionId(dropKey);
    setRestoredSnapshotsBySessionId(dropKey);
    setWorkspace((current) => {
      if (!current) return current;
      const pane = Object.values(current.panes).find(
        (entry) => entry.sessionId === sessionId,
      );
      if (!pane) return current;
      const desktop = findDesktopForPane(current, pane.id);
      return closePane(current, pane.id, desktop?.id ?? current.activeDesktopId);
    });
  }

  function handleToggleMaximizePane(paneId: string) {
    setWorkspace((current) => (current ? toggleMaximize(current, paneId) : current));
  }

  async function handleChangeProjectRoot(desktopId: string) {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Pick a git repository for this view",
    }).catch((error) => {
      console.error("folder picker failed", error);
      return null;
    });
    if (!picked || typeof picked !== "string") return;
    setWorkspace((current) =>
      current ? setDesktopProjectRoot(current, desktopId, picked) : current,
    );
  }

  async function handleNewDesktop() {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Pick project folder for new view",
    }).catch((error) => {
      console.error("folder picker failed", error);
      return null;
    });
    if (!picked || typeof picked !== "string") return;
    const sessionId = await createTerminal(picked);
    const title = `shell ${Object.keys(sessionInfoById).length + 1}`;
    await hydrateSessionInfo(sessionId, title);
    setWorkspace((current) =>
      current
        ? createDesktop(current, createPaneRecord(sessionId, title), picked)
        : createWorkspace(createPaneRecord(sessionId, title), picked),
    );
  }

  function handleNewTerminalInActiveDesktop() {
    if (!workspace) return;
    const desktop = activeDesktop(workspace);
    if (desktop.layout) return;
    createDraftPane({ kind: "root", desktopId: workspace.activeDesktopId });
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
      cleanupClosedSession(sessionId);
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
    handleFocusPaneAnywhere(pane.id);
  }

  function handleFocusPaneAnywhere(paneId: string) {
    setWorkspace((current) => {
      if (!current) return current;
      if (!(paneId in current.panes)) return current;
      const owningDesktop = findDesktopForPane(current, paneId);
      const switched = owningDesktop
        ? switchDesktop(current, owningDesktop.id)
        : current;
      return focusPane(switched, paneId, owningDesktop?.id ?? switched.activeDesktopId);
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

  const blockedSessionIds = useBlockedSessionIds();
  const blockedSessionIdSet = useMemo(
    () => new Set(blockedSessionIds),
    [blockedSessionIds],
  );

  const worktreeRows: WorktreeRow[] = (() => {
    if (!workspace || !activeProjectRoot) return [];
    const entry = worktreesByRepo[activeProjectRoot];
    if (!entry || entry.state !== "ready") return [];
    return entry.worktrees.map((wt) => {
      const attachedPanes = Object.values(workspace.panes).filter((pane) => {
        const info = sessionInfoById[pane.sessionId];
        if (!info) return false;
        const effective = info.worktree_path || info.cwd;
        return pathsEqual(effective, wt.path);
      });
      const status = statusByWorktreePath[wt.path];
      return {
        path: wt.path,
        branchName: wt.branch,
        isLastty: wt.is_lastty,
        isMain: wt.is_main,
        uncommittedFiles: status?.uncommitted_files ?? 0,
        unmergedCommits: wt.is_main ? 0 : status?.unmerged_commits ?? 0,
        changedFiles: status?.changed_files ?? [],
        liveSessions: attachedPanes.length,
        firstLivePaneId: attachedPanes[0]?.id ?? null,
        merged: mergedWorktreePaths.has(wt.path),
      };
    });
  })();

  const mergeableCount = worktreeRows.filter(
    (row) => !row.isMain && !row.merged,
  ).length;

  const blockedRefs: BlockedSessionRef[] = blockedSessionIds.map((sessionId) => ({
    sessionId,
    taskName: deriveTaskName(sessionInfoById[sessionId]),
  }));

  const desktopEntries: DesktopEntry[] = workspace
    ? workspace.desktops.map((desktop) => {
        const paneIds = desktop.layout ? orderedPaneIds(desktop.layout) : [];
        const hasBlocked = paneIds.some((paneId) => {
          const pane = workspace.panes[paneId];
          return pane ? blockedSessionIdSet.has(pane.sessionId) : false;
        });
        return {
          id: desktop.id,
          name: desktop.name,
          projectLabel: basenameOfPath(desktop.projectRoot),
          paneCount: paneIds.length,
          hasBlocked,
        };
      })
    : [];

  if (!workspace) {
    return (
      <div
        className="agent-root"
        data-platform={platform}
        style={{
          display: "grid",
          placeItems: "center",
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-secondary)",
        }}
      >
        Booting terminal workspace…
        <UpdateBadge activeSessionCount={0} />
      </div>
    );
  }

  const activeSessionCount = Object.keys(sessionInfoById).length;

  return (
    <div className="agent-root" data-platform={platform}>
      <UpdateBadge activeSessionCount={activeSessionCount} />
      <AgentShell
        blocked={blockedRefs}
        onJumpToBlocked={handleJumpToBlocked}
        worktreeRows={worktreeRows}
        agents={agents}
        projectRoot={activeProjectRoot || ""}
        onChangeProjectRoot={() => {
          if (workspace) void handleChangeProjectRoot(workspace.activeDesktopId);
        }}
        onFocusPane={(paneId) => handleFocusPaneAnywhere(paneId)}
        onAttach={(worktreePath, choice) =>
          void handleAttachToWorktree(worktreePath, choice)
        }
        onMerge={(worktreePath) => setMergeDialog({ focusPath: worktreePath })}
        onAbandon={(worktreePath) => void handleAbandonWorktree(worktreePath)}
        mergeable={mergeableCount}
        onOpenMergeDialog={() => setMergeDialog({ focusPath: null })}
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
              sessionCreationOrder={sessionCreationOrder}
            />
          );
        }}
        exposeMode={exposeMode}
        onToggleExpose={() => setExposeMode((value) => !value)}
        sidebarFooterExtras={
          <button
            type="button"
            className="agent-settings-toggle"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>
        }
        sidebarGraph={sidebarGraph}
        nowMs={clock}
      >
        <div className={`agent-grid ${exposeMode ? "agent-expose-active" : ""}`}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              position: "relative",
            }}
          >
            {(() => {
              const cells = computeDesktopCells(workspace.desktops.length);
              return workspace.desktops.map((desktop, index) => {
                const active = desktop.id === workspace.activeDesktopId;
                const cell = cells[index];
                let scaledTransform = "none";
                if (cell) {
                  const scale = Math.min(cell.width, cell.height);
                  const offsetX = (cell.width - scale) / 2;
                  const offsetY = (cell.height - scale) / 2;
                  scaledTransform = `translate(${(cell.left + offsetX) * 100}%, ${(cell.top + offsetY) * 100}%) scale(${scale})`;
                }
                const transform = exposeMode ? scaledTransform : "none";
                const hidden = !exposeMode && !active;
                return (
                  <div
                    key={desktop.id}
                    className={`agent-desktop-layer ${hidden ? "is-hidden" : ""}`}
                    aria-hidden={hidden}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      transform,
                    }}
                  >
                    {desktop.layout ? (
                      <DesktopStage
                        exposeMode={exposeMode}
                        onExitExpose={() => setExposeMode(false)}
                        ctx={{
                          desktop,
                          workspace,
                          sessionInfoById,
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
                          onFocus: (paneId) => handleFocusPaneAnywhere(paneId),
                          onSnapshot: handleTerminalSnapshot,
                          onApproval: (sessionId, approvalId, choice) => {
                            void respondToApproval(sessionId, approvalId, choice).then(() => {
                              useAgentStore.getState().resolveApproval(sessionId, approvalId);
                            });
                          },
                          onSpawnAdjacent: (paneId, direction) =>
                            createDraftPane({
                              kind: "split",
                              paneId,
                              direction:
                                direction === "right" ? "horizontal" : "vertical",
                            }),
                          draggingPaneId,
                          onDragStartPane: (paneId) => setDraggingPaneId(paneId),
                          onDragEndPane: () => setDraggingPaneId(null),
                          onDropPaneOnEdge: handleDropPaneOnEdge,
                          onDropPaneOnBody: handleDropPaneOnBody,
                          historyPanelPaneId,
                          viewingHistoryByPaneId,
                          onToggleHistoryPanel: handleToggleHistoryPanel,
                          onCloseHistoryPanel: handleCloseHistoryPanel,
                          onResumeHistoryEntry: handleResumeHistoryEntry,
                          onViewHistoryTranscript: handleViewHistoryTranscript,
                          onCloseHistoryView: handleCloseHistoryView,
                          draftPaneIds,
                          renderDraftLauncher: (paneId) => (
                            <LaunchAgentModal
                              key={paneId}
                              agents={agents}
                              worktrees={worktreeRows}
                              launching={launching}
                              projectLabel={
                                basenameOfPath(activeProjectRoot || "") || "project"
                              }
                              initialAgentId={
                                draftSeedByPaneId[paneId]
                                ?? resolvedLastAgentId
                                ?? agents[0]?.id
                                ?? ""
                              }
                              onClose={() => cancelDraftPane(paneId)}
                              onLaunch={(config) => handleLaunchAgent(paneId, config)}
                            />
                          ),
                        }}
                      />
                    ) : (
                      <EmptyDesktop onNewTerminal={() => void handleNewTerminalInActiveDesktop()} />
                    )}
                  </div>
                );
              });
            })()}
            {exposeMode && (
              <div className="agent-expose-hint no-select" aria-hidden>
                Overview — press <kbd>\</kbd> or <kbd>Esc</kbd> to return
              </div>
            )}
          </div>
        </div>
      </AgentShell>
      {autoPromoteNotice && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--color-surface-raised, rgba(30, 30, 30, 0.95))",
            color: "var(--color-text-primary, #f4f4f4)",
            padding: "8px 14px",
            borderRadius: 6,
            fontSize: 12,
            boxShadow: "0 6px 24px rgba(0, 0, 0, 0.35)",
            zIndex: 100,
            maxWidth: 480,
          }}
        >
          {autoPromoteNotice}
        </div>
      )}
      {mergeDialog && activeProjectRoot && (
        <MergeDialog
          repoRoot={activeProjectRoot}
          worktrees={worktreeRows}
          focusWorktreePath={mergeDialog.focusPath}
          defaultSelectedPaths={
            new Set(
              worktreeRows
                .filter((row) => !row.isMain && !row.merged)
                .map((row) => row.path),
            )
          }
          onClose={() => setMergeDialog(null)}
          onPrOpenedSuccess={(path) => {
            setMergedWorktreePaths((prev) => {
              const next = new Set(prev);
              next.add(path);
              return next;
            });
            invalidateWorktreeStatus(path);
          }}
        />
      )}
      <KeyboardHelpOverlay
        onClose={() => setHelpOpen(false)}
        open={helpOpen}
        mode={keyboardMode.mode}
        platform={platform}
      />
      <SettingsPanel
        open={settingsOpen}
        keyboardMode={keyboardMode.mode}
        themeOverride={theme.override}
        onKeyboardModeChange={keyboardMode.setMode}
        onThemeOverrideChange={theme.setOverride}
        onClose={() => setSettingsOpen(false)}
      />
      <NotificationToasts sessionInfoById={sessionInfoById} />
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      <button
        type="button"
        onClick={() => setChatOpen((open) => !open)}
        title="Peer chat"
        aria-label="Toggle peer chat"
        style={{
          position: "fixed",
          right: 14,
          bottom: 14,
          width: 36,
          height: 36,
          borderRadius: 18,
          border: "0.5px solid var(--color-border-secondary)",
          background: "var(--color-background-primary)",
          color: "var(--color-text-primary)",
          cursor: "pointer",
          zIndex: chatOpen ? 59 : 60,
          display: chatOpen ? "none" : "grid",
          placeItems: "center",
          fontSize: 16,
        }}
      >
        💬
      </button>
    </div>
  );
}

interface RenderLayoutCtx {
  desktop: DesktopState;
  workspace: WorkspaceState;
  sessionInfoById: Record<string, SessionInfo>;
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
  historyPanelPaneId: string | null;
  viewingHistoryByPaneId: Record<string, HistoryEntry>;
  onToggleHistoryPanel: (paneId: string) => void;
  onCloseHistoryPanel: () => void;
  onResumeHistoryEntry: (paneId: string, entry: HistoryEntry) => void;
  onViewHistoryTranscript: (paneId: string, entry: HistoryEntry) => void;
  onCloseHistoryView: (paneId: string) => void;
  draftPaneIds: Set<string>;
  renderDraftLauncher: (paneId: string) => ReactNode;
}

function DesktopStage({
  ctx,
  exposeMode,
  onExitExpose,
}: {
  ctx: RenderLayoutCtx;
  exposeMode: boolean;
  onExitExpose: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setStageSize({ w: el.clientWidth, h: el.clientHeight });
    });
    observer.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const { desktop } = ctx;
  const layout = desktop.layout;
  if (!layout) return null;

  const rects = collectPaneRects(layout);
  const maximizedId = desktop.maximizedPaneId;
  const handles = exposeMode || maximizedId ? [] : collectSplitHandles(layout);

  return (
    <div ref={stageRef} className="agent-stage">
      <div className="agent-stage__inner">
        {Object.entries(rects).map(([paneId, rect]) => {
          const effectiveRect =
            maximizedId && maximizedId === paneId
              ? { left: 0, top: 0, right: 1, bottom: 1 }
              : rect;
          return (
            <PaneTile
              key={paneId}
              paneId={paneId}
              rect={effectiveRect}
              ctx={ctx}
              zoomed={maximizedId === paneId}
              dimmed={Boolean(maximizedId) && maximizedId !== paneId}
              exposeMode={exposeMode}
              onExitExpose={onExitExpose}
            />
          );
        })}
        {handles.map((handle, index) => (
          <SplitHandle
            key={`handle-${handle.path.join("-")}-${handle.handleIndex}-${index}`}
            handle={handle}
            stageSize={stageSize}
            onResize={ctx.onResize}
          />
        ))}
      </div>
    </div>
  );
}

const TILE_GAP_PX = 1;

function PaneTile({
  paneId,
  rect,
  ctx,
  zoomed,
  dimmed,
  exposeMode,
  onExitExpose,
}: {
  paneId: string;
  rect: PaneRect;
  ctx: RenderLayoutCtx;
  zoomed: boolean;
  dimmed: boolean;
  exposeMode: boolean;
  onExitExpose: () => void;
}) {
  const {
    desktop,
    workspace,
    sessionInfoById,
    restoredSnapshotsBySessionId,
    onCloseChrome,
    onToggleMaximize,
    onFocus,
    onSnapshot,
    onApproval,
    onSpawnAdjacent,
    draggingPaneId,
    onDragStartPane,
    onDragEndPane,
    onDropPaneOnEdge,
    onDropPaneOnBody,
    historyPanelPaneId,
    viewingHistoryByPaneId,
    onToggleHistoryPanel,
    onCloseHistoryPanel,
    onResumeHistoryEntry,
    onViewHistoryTranscript,
    onCloseHistoryView,
    draftPaneIds,
    renderDraftLauncher,
  } = ctx;

  const pane = workspace.panes[paneId];
  if (!pane) return null;

  const focused = desktop.focusedPaneId === pane.id;
  const widthPct = (rect.right - rect.left) * 100;
  const heightPct = (rect.bottom - rect.top) * 100;
  const leftPct = rect.left * 100;
  const topPct = rect.top * 100;

  const tileStyle: CSSProperties = {
    left: `calc(${leftPct}% + ${TILE_GAP_PX / 2}px)`,
    top: `calc(${topPct}% + ${TILE_GAP_PX / 2}px)`,
    width: `calc(${widthPct}% - ${TILE_GAP_PX}px)`,
    height: `calc(${heightPct}% - ${TILE_GAP_PX}px)`,
    zIndex: zoomed ? 3 : focused ? 2 : 1,
  };

  const handleTileClick = () => {
    if (exposeMode) {
      onFocus(pane.id);
      onExitExpose();
    }
  };

  if (draftPaneIds.has(pane.id)) {
    return (
      <div
        className={`agent-pane-tile ${dimmed ? "is-dimmed" : ""}`}
        style={tileStyle}
        onClick={handleTileClick}
      >
        <section
          className={`agent-window-shell is-draft ${focused ? "is-focused" : ""}`}
          onMouseDown={() => onFocus(pane.id)}
        >
          {renderDraftLauncher(pane.id)}
          <EdgeSpawner onSpawn={(direction) => onSpawnAdjacent(pane.id, direction)} />
        </section>
      </div>
    );
  }

  const session = sessionInfoById[pane.sessionId];
  const agent = useAgentSession(pane.sessionId);
  const blocked = agent.pendingApprovals.length > 0;
  const status: AgentStatus = deriveAgentStatus(agent, Boolean(agent.finished));
  const taskName = deriveTaskName(session);
  const agentType = deriveAgentType(session);
  const worktreeLabel = session?.worktree_path
    ? basenameOfPath(session.worktree_path)
    : session?.cwd
      ? basenameOfPath(session.cwd)
      : null;
  const progressPct = deriveProgressPct(agent);
  const toolCounts = toolCallCount(agent);
  const showInspector =
    toolCounts.total > 0 || agent.fileEdits.length > 0 || agent.widgets.length > 0;

  return (
    <div
      className={`agent-pane-tile ${dimmed ? "is-dimmed" : ""}`}
      style={tileStyle}
      onClick={handleTileClick}
    >
      <section
        className={`agent-window-shell ${focused ? "is-focused" : ""} ${
          status === "needs_help" ? "is-needs-help" : ""
        }`}
        onMouseDown={() => onFocus(pane.id)}
      >
        <WindowHeader
          taskName={taskName}
          agentType={agentType}
          progressPct={progressPct}
          status={status}
          controls={{
            onClose: () => void onCloseChrome(pane.id),
            onMaximize: () => onToggleMaximize(pane.id),
            maximized: zoomed,
          }}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-lastty-pane", pane.id);
            onDragStartPane(pane.id);
          }}
          onDragEnd={onDragEndPane}
          onHistoryClick={() => onToggleHistoryPanel(pane.id)}
          historyActive={historyPanelPaneId === pane.id}
        />
        {historyPanelPaneId === pane.id && (
          <HistoryPanel
            activeSessionId={pane.sessionId}
            onResume={(entry) => onResumeHistoryEntry(pane.id, entry)}
            onViewTranscript={(entry) => onViewHistoryTranscript(pane.id, entry)}
            onClose={onCloseHistoryPanel}
          />
        )}
        <ProgressBar pct={progressPct} status={status} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: "grid",
            gridTemplateColumns: showInspector ? "minmax(0, 1fr) 320px" : "minmax(0, 1fr)",
            gridTemplateRows: "minmax(0, 1fr)",
            position: "relative",
          }}
        >
          {viewingHistoryByPaneId[pane.id] ? (
            <TranscriptView
              entry={viewingHistoryByPaneId[pane.id]!}
              onClose={() => onCloseHistoryView(pane.id)}
            />
          ) : (
            <TerminalViewport
              blocked={blocked}
              focused={focused}
              onActivate={() => onFocus(pane.id)}
              onSnapshotChange={(snapshot) => onSnapshot(pane.sessionId, snapshot)}
              restoredSnapshot={restoredSnapshotsBySessionId[pane.sessionId] ?? null}
              sessionId={pane.sessionId}
            />
          )}
          {showInspector && <AgentInspector agent={agent} />}
          {draggingPaneId && draggingPaneId !== pane.id && (
            <PaneDropOverlay
              onDropEdge={(side) => onDropPaneOnEdge(draggingPaneId, pane.id, side)}
              onDropBody={() => onDropPaneOnBody(draggingPaneId, pane.id)}
            />
          )}
        </div>
        {blocked ? (
          <ReplyInput
            approval={agent.pendingApprovals[0]!}
            onSubmit={(choice) =>
              onApproval(pane.sessionId, agent.pendingApprovals[0]!.id, choice)
            }
          />
        ) : (
          <PaneFooter
            worktreeLabel={worktreeLabel}
            isolated={Boolean(session?.worktree_path)}
          />
        )}
        <EdgeSpawner onSpawn={(direction) => onSpawnAdjacent(pane.id, direction)} />
      </section>
      {exposeMode && (
        <div className="agent-expose-hover-badge" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2 2 h4 M2 2 v4" strokeLinecap="round" />
            <path d="M14 2 h-4 M14 2 v4" strokeLinecap="round" />
            <path d="M2 14 h4 M2 14 v-4" strokeLinecap="round" />
            <path d="M14 14 h-4 M14 14 v-4" strokeLinecap="round" />
          </svg>
          <span>Jump</span>
        </div>
      )}
    </div>
  );
}

function SplitHandle({
  handle,
  stageSize,
  onResize,
}: {
  handle: SplitHandleInfo;
  stageSize: { w: number; h: number };
  onResize: (
    path: LayoutPath,
    handleIndex: number,
    delta: number,
    baseWeights: number[],
  ) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const horizontal = handle.direction === "horizontal";
  const hoverSize = 8;
  const style: CSSProperties = horizontal
    ? {
        left: `calc(${handle.position * 100}% - ${hoverSize / 2}px)`,
        top: `${handle.start * 100}%`,
        width: hoverSize,
        height: `${(handle.end - handle.start) * 100}%`,
      }
    : {
        left: `${handle.start * 100}%`,
        top: `calc(${handle.position * 100}% - ${hoverSize / 2}px)`,
        width: `${(handle.end - handle.start) * 100}%`,
        height: hoverSize,
      };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const totalWeight = handle.weights.reduce((sum, weight) => sum + weight, 0);
    const extentPx =
      (horizontal ? stageSize.w : stageSize.h) * handle.parentExtent;
    if (extentPx <= 0 || totalWeight <= 0) return;

    const startPosition = horizontal ? event.clientX : event.clientY;
    const baseWeights = handle.weights;
    const handleEl = event.currentTarget;
    const pointerId = event.pointerId;
    handleEl.setPointerCapture(pointerId);
    setDragging(true);

    const onMove = (moveEvent: PointerEvent) => {
      const nextPosition = horizontal ? moveEvent.clientX : moveEvent.clientY;
      const pixelDelta = nextPosition - startPosition;
      const weightDelta = (pixelDelta / extentPx) * totalWeight;
      onResize(handle.path, handle.handleIndex, weightDelta, baseWeights);
    };
    const cleanup = () => {
      handleEl.removeEventListener("pointermove", onMove as EventListener);
      handleEl.removeEventListener("pointerup", cleanup);
      handleEl.removeEventListener("pointercancel", cleanup);
      if (handleEl.hasPointerCapture(pointerId)) {
        handleEl.releasePointerCapture(pointerId);
      }
      setDragging(false);
    };

    handleEl.addEventListener("pointermove", onMove as EventListener);
    handleEl.addEventListener("pointerup", cleanup);
    handleEl.addEventListener("pointercancel", cleanup);
  };

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      className={`agent-split-handle is-${handle.direction}${dragging ? " is-dragging" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
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

function EmptyDesktop({ onNewTerminal }: { onNewTerminal: () => void }) {
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
        onClick={onNewTerminal}
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
        New terminal
      </button>
    </div>
  );
}

interface LaunchAgentConfig {
  agentId: string;
  prompt: string;
  worktreeChoice: string;
  launchCount: number;
  branchName: string;
}

function LaunchAgentModal({
  agents,
  worktrees,
  launching,
  projectLabel,
  initialAgentId,
  onClose,
  onLaunch,
}: {
  agents: AgentDefinition[];
  worktrees: WorktreeRow[];
  launching: boolean;
  projectLabel: string;
  initialAgentId: string;
  onClose: () => void;
  onLaunch: (config: LaunchAgentConfig) => void;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    initialAgentId || agents[0]?.id || "",
  );
  const [prompt, setPrompt] = useState("");
  const [worktreeChoice, setWorktreeChoice] = useState<string>("in_place");
  const [launchCount, setLaunchCount] = useState<number>(1);
  const [branchName, setBranchName] = useState<string>("");
  const isShell = selectedAgentId === "shell";
  const selectedAgent = isShell
    ? { id: "shell", name: "Shell" }
    : agents.find((a) => a.id === selectedAgentId) ?? agents[0];

  const agentOptions = [
    { value: "shell", label: "Shell", sublabel: "plain terminal" },
    ...agents.map((agent) => ({
      value: agent.id,
      label: agent.name,
      sublabel: agent.command,
    })),
  ];

  const worktreeOptions = [
    ...(!isShell
      ? [
          {
            value: "in_place",
            label: "main (in-place)",
            sublabel: "run in the main checkout",
          },
          {
            value: "new",
            label: "new worktree",
            sublabel: "fresh branch off main",
          },
        ]
      : []),
    ...worktrees
      .filter((wt) => !wt.isMain)
      .map((wt) => ({
        value: wt.path,
        label: wt.branchName || basenameOfPath(wt.path) || "(detached)",
        sublabel: wt.isLastty ? "lastty worktree" : undefined,
      })),
  ];

  const effectiveChoice =
    worktreeOptions.some((o) => o.value === worktreeChoice)
      ? worktreeChoice
      : worktreeOptions[0]?.value ?? "in_place";

  const worktreeLabel = (() => {
    const opt = worktreeOptions.find((o) => o.value === effectiveChoice);
    return opt?.label ?? "worktree";
  })();

  const canLaunch = Boolean(selectedAgentId) && !launching;
  const submitLaunch = () => {
    if (!canLaunch) return;
    onLaunch({
      agentId: selectedAgentId,
      prompt,
      worktreeChoice: effectiveChoice,
      launchCount,
      branchName,
    });
  };

  return (
    <div className="agent-launcher agent-launcher--inline">
      <div className="agent-launcher__header">
        <span className="agent-launcher__title">New terminal</span>
        <button
          type="button"
          className="agent-launcher__close"
          onClick={onClose}
          aria-label="cancel"
          title="cancel"
        >
          ×
        </button>
      </div>
        {!isShell && (
          <textarea
            className="agent-launcher__prompt"
            placeholder="Describe a task"
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submitLaunch();
              }
            }}
            autoFocus
          />
        )}
        <div className="agent-launcher__chips">
          <ChipMenu
            icon="▣"
            label={selectedAgent?.name ?? "Agent"}
            options={agentOptions}
            value={selectedAgentId}
            onChange={setSelectedAgentId}
          />
          <span
            className="agent-launcher__chip is-readonly"
            title="active view's project folder"
          >
            <span aria-hidden="true">📁</span>
            {projectLabel}
          </span>
          <ChipMenu
            icon="⎇"
            label={worktreeLabel}
            options={worktreeOptions}
            value={effectiveChoice}
            onChange={setWorktreeChoice}
          />
          {!isShell && (
            <ChipMenu
              icon="⊞"
              label={`${launchCount}×`}
              options={[1, 2, 3, 4, 5].map((n) => ({
                value: String(n),
                label: `${n}×`,
                sublabel:
                  n === 1 ? "one agent" : `${n} parallel agents, each isolated`,
              }))}
              value={String(launchCount)}
              onChange={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isNaN(parsed)) setLaunchCount(parsed);
              }}
            />
          )}
          {!isShell && worktreeChoice === "new" && launchCount === 1 && (
            <input
              className="agent-launcher__branch-input"
              placeholder="branch name (optional)"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
            />
          )}
          <div className="agent-launcher__spacer" />
          <button
            type="button"
            className="agent-launcher__launch"
            disabled={!canLaunch}
            onClick={submitLaunch}
            title="Launch (⌘↵)"
          >
            {launching ? "launching…" : "launch ⌘↵"}
          </button>
        </div>
    </div>
  );
}

function ChipMenu({
  icon,
  label,
  options,
  value,
  onChange,
}: {
  icon: string;
  label: string;
  options: Array<{ value: string; label: string; sublabel?: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  return (
    <div className="agent-launcher__chip-wrap" ref={ref}>
      <button
        type="button"
        className="agent-launcher__chip"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden="true">{icon}</span>
        {label}
        <span className="agent-launcher__chip-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="agent-launcher__chip-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`agent-launcher__chip-menu-item ${
                option.value === value ? "is-selected" : ""
              }`}
              onClick={() => {
                setOpen(false);
                onChange(option.value);
              }}
            >
              <span className="agent-launcher__chip-menu-label">
                {option.label}
              </span>
              {option.sublabel && (
                <span className="agent-launcher__chip-menu-sub">
                  {option.sublabel}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

