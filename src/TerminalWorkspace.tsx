import {
  useEffect,
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
  resumeHistoryEntry,
} from "./lib/ipc";
import { layoutGraph } from "./lib/graphLayout";
import type { SidebarGraph } from "./components/agent/Sidebar";

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
  const [agentUiBySession, setAgentUiBySession] = useState<
    Record<string, AgentSessionState>
  >({});
  const focusedSessionIdRef = useRef<string | null>(null);
  const [draftPaneIds, setDraftPaneIds] = useState<Set<string>>(() => new Set());
  const [draftSeedByPaneId, setDraftSeedByPaneId] = useState<Record<string, string>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const platform = useMemo(() => detectPlatform(), []);
  const pendingBindingRef = useRef<PendingBinding[]>([]);
  const [launching, setLaunching] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [hydrated, setHydrated] = useState(false);
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
    if (!activeProjectRoot) return;
    if (nonGitPromptedRef.current.has(activeProjectRoot)) return;
    const desktopId = workspace.activeDesktopId;
    nonGitPromptedRef.current.add(activeProjectRoot);
    void isGitRepo(activeProjectRoot).then((isRepo) => {
      if (isRepo) return;
      void handleChangeProjectRoot(desktopId);
    });
  }, [hydrated, workspace, activeProjectRoot]);

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
      const sid = event.payload.session_id;
      setAgentUiBySession((current) => ({
        ...current,
        [sid]: reduceAgentMessage(
          current[sid] ?? emptyAgentSessionState(),
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
      if (helpOpen || settingsOpen) return;
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
  }, [workspace, platform, keyboardMode.mode, helpOpen, settingsOpen]);

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
          attach_to_worktree: isMainRow ? null : worktreePath,
          isolate_in_worktree: isMainRow,
        });
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
    const desktop = activeDesktop(workspace);
    setLaunching(true);
    try {
      const count = Math.max(1, Math.min(5, config.launchCount));
      const isolate = config.worktreeChoice === "new";
      const attachPath = isolate ? null : config.worktreeChoice;
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
          const result = await launchAgent({
            agent_id: config.agentId,
            prompt: config.prompt || null,
            cwd: attachPath || desktop.projectRoot || null,
            isolate_in_worktree: isolate,
            branch_name:
              isolate && count === 1 ? config.branchName || null : null,
            attach_to_worktree: attachPath,
          });
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
    setAgentUiBySession(dropKey);
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

  function handleNewShellInActiveDesktop() {
    if (!workspace) return;
    const desktop = activeDesktop(workspace);
    if (desktop.layout) return;
    createDraftPane({ kind: "root", desktopId: workspace.activeDesktopId }, "shell");
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

  const toastNotifications = Object.entries(agentUiBySession).flatMap(([sessionId, state]) =>
    visibleNotifications(state, clock).map((notification) => ({
      sessionId,
      notification,
    })),
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
              agentUiBySession={agentUiBySession}
              sessionCreationOrder={sessionCreationOrder}
            />
          );
        }}
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
        <div className="agent-grid">
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              position: "relative",
            }}
          >
            {workspace.desktops.map((desktop) => {
              const active = desktop.id === workspace.activeDesktopId;
              return (
                <div
                  key={desktop.id}
                  className="agent-desktop-layer"
                  aria-hidden={!active}
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    visibility: active ? "visible" : "hidden",
                    pointerEvents: active ? "auto" : "none",
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
                            draftSeedByPaneId[paneId] ?? agents[0]?.id ?? ""
                          }
                          onClose={() => cancelDraftPane(paneId)}
                          onLaunch={(config) => handleLaunchAgent(paneId, config)}
                        />
                      ),
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

  const maximizedPaneId = desktop.maximizedPaneId;

  if (node.type === "leaf") {
    const pane = workspace.panes[node.paneId];
    if (!pane) return null;
    if (maximizedPaneId && maximizedPaneId !== pane.id) return null;

    if (draftPaneIds.has(pane.id)) {
      const focused = desktop.focusedPaneId === pane.id;
      return (
        <section
          key={pane.id}
          className={`agent-window-shell is-draft ${focused ? "is-focused" : ""}`}
          onMouseDown={() => onFocus(pane.id)}
        >
          {renderDraftLauncher(pane.id)}
        </section>
      );
    }

    const session = sessionInfoById[pane.sessionId];
    const agent = agentUiBySession[pane.sessionId] ?? emptyAgentSessionState();
    const blocked = agent.pendingApprovals.length > 0;
    const focused = desktop.focusedPaneId === pane.id;
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
  const [worktreeChoice, setWorktreeChoice] = useState<string>("new");
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
            value: "new",
            label: "new worktree",
            sublabel: "fresh branch off main",
          },
        ]
      : []),
    ...worktrees.map((wt) => ({
      value: wt.path,
      label: wt.branchName || basenameOfPath(wt.path) || "(detached)",
      sublabel: wt.isMain
        ? "primary checkout"
        : wt.isLastty
          ? "lastty worktree"
          : undefined,
    })),
  ];

  const effectiveChoice =
    worktreeOptions.some((o) => o.value === worktreeChoice)
      ? worktreeChoice
      : worktreeOptions[0]?.value ?? "new";

  const worktreeLabel = (() => {
    const opt = worktreeOptions.find((o) => o.value === effectiveChoice);
    return opt?.label ?? "worktree";
  })();

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
            disabled={!selectedAgentId || launching}
            onClick={() =>
              onLaunch({
                agentId: selectedAgentId,
                prompt,
                worktreeChoice: effectiveChoice,
                launchCount,
                branchName,
              })
            }
          >
            {launching ? "launching…" : "launch ↵"}
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

const widgetBodyStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  fontSize: 12,
  color: "var(--color-text-primary)",
};
