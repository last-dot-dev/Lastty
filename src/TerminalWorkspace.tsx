import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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
  recentRuleTriggerCounts,
  summarizeRuleAction,
  summarizeRuleTrigger,
} from "./app/rules";
import {
  buildPersistedWorkspaceState,
  buildRestoredWorkspaceState,
  persistWorkspaceState,
  readPersistedWorkspaceState,
  type PersistedTerminalSnapshot,
} from "./app/sessionRestore";
import TerminalViewport from "./components/TerminalViewport";
import RecordingReplay from "./components/RecordingReplay";
import {
  createTerminal,
  getPrimarySessionId,
  killTerminal,
  launchAgent,
  listAgents,
  listRecordings,
  listRules,
  listSessions,
  readRecording,
  respondToApproval,
  restoreTerminalSessions,
  type AgentDefinition,
  type AgentUiEvent,
  type BusEvent,
  type LaunchAgentResult,
  type RecordingInfo,
  type RuleDefinition,
  type SessionExitEvent,
  type SessionInfo,
  type SessionTitleEvent,
} from "./lib/ipc";

export default function TerminalWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [recordings, setRecordings] = useState<Record<string, RecordingInfo>>({});
  const [recordingPreview, setRecordingPreview] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleDefinition[]>([]);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [sessionInfoById, setSessionInfoById] = useState<Record<string, SessionInfo>>({});
  const [agentUiBySession, setAgentUiBySession] = useState<
    Record<string, AgentSessionState>
  >({});
  const [recentBusEvents, setRecentBusEvents] = useState<BusEvent[]>([]);
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

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [loadedAgents, recordingItems, loadedRules] = await Promise.all([
          listAgents().catch((error) => {
            console.error("failed to load agents", error);
            return [] as AgentDefinition[];
          }),
          listRecordings().catch((error) => {
            console.error("failed to load recordings", error);
            return [] as RecordingInfo[];
          }),
          listRules().catch((error) => {
            console.error("failed to load rules", error);
            setRulesError(String(error));
            return [] as RuleDefinition[];
          }),
        ]);
        if (cancelled) return;

        setAgents(loadedAgents);
        setSelectedAgentId((current) => current || loadedAgents[0]?.id || "");
        setRecordings(Object.fromEntries(recordingItems.map((item) => [item.session_id, item])));
        setRules(loadedRules);
        if (loadedRules.length > 0) {
          setRulesError(null);
        }

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

    void listen<BusEvent>("bus:event", (event) => {
      setRecentBusEvents((current) => [...current.slice(-29), event.payload]);
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

  async function handleRestartSession(sessionId: string) {
    const pane = workspace
      ? Object.values(workspace.panes).find((entry) => entry.sessionId === sessionId)
      : undefined;
    const session = sessionInfoById[sessionId];
    if (!pane || !session) return;

    if (session.agent_id) {
      const result = await launchAgent({
        agent_id: session.agent_id,
        prompt: session.prompt,
        cwd: session.cwd,
        isolate_in_worktree: Boolean(session.worktree_path),
        branch_name: session.worktree_path
          ? `${session.agent_id.replace(/[^a-zA-Z0-9_-]/g, "-")}-restart-${Date.now()}`
          : null,
      });
      await killTerminal(sessionId).catch(() => {});
      applyRestartedSession(pane.id, result, session);
    } else {
      const newSessionId = await createTerminal(session.cwd);
      await killTerminal(sessionId).catch(() => {});
      upsertSession({
        session_id: newSessionId,
        title: session.title,
        agent_id: null,
        cwd: session.cwd,
        prompt: null,
        prompt_summary: null,
        worktree_path: null,
        control_connected: false,
        started_at_ms: 0,
      });
      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          panes: {
            ...current.panes,
            [pane.id]: {
              ...current.panes[pane.id],
              sessionId: newSessionId,
              title: session.title,
            },
          },
        };
      });
    }
  }

  function upsertSession(session: SessionInfo) {
    setSessionInfoById((current) => ({
      ...current,
      [session.session_id]: session,
    }));
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

  function applyRestartedSession(
    paneId: string,
    result: LaunchAgentResult,
    previous: SessionInfo,
  ) {
    upsertSession({
      session_id: result.session_id,
      title: result.pane_title,
      agent_id: previous.agent_id,
      cwd: result.cwd,
      prompt: previous.prompt,
      prompt_summary: previous.prompt_summary,
      worktree_path: result.worktree_path ?? null,
      control_connected: false,
      started_at_ms: 0,
    });
    setWorkspace((current) => {
      if (!current) return current;
      return {
        ...current,
        panes: {
          ...current.panes,
          [paneId]: {
            ...current.panes[paneId],
            sessionId: result.session_id,
            title: result.pane_title,
          },
        },
      };
    });
  }

  const toastNotifications = Object.entries(agentUiBySession).flatMap(([sessionId, state]) =>
    visibleNotifications(state, clock).map((notification) => ({
      sessionId,
      notification,
    })),
  );

  if (!workspace) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "grid",
          placeItems: "center",
          background: "#0b0d12",
          color: "#c3cad8",
          fontFamily: "monospace",
        }}
      >
        Booting terminal workspace…
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background:
          "radial-gradient(circle at top left, rgba(92,123,172,0.18), transparent 28%), #0b0d12",
        color: "#d6d9e0",
        display: "grid",
        gridTemplateRows: "auto auto 1fr",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "12px 16px",
          borderBottom: "1px solid #1d2230",
          background: "rgba(9, 11, 17, 0.88)",
          backdropFilter: "blur(18px)",
        }}
      >
        <div>
          <div style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1.2 }}>
            Lastty Workspace
          </div>
          <div style={{ fontSize: 11, color: "#7b8498", fontFamily: "monospace" }}>
            `Ctrl+Shift+H/V` split, drag dividers resize, `Ctrl+Shift+W` close, `Ctrl+Shift+L` launcher, arrows move focus spatially
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ChromeButton label="+" onClick={() => setLauncherOpen(true)} />
          <div style={{ fontSize: 11, color: "#7b8498", fontFamily: "monospace" }}>
            renderer `xterm` default, `wgpu` via `LASTTY_RENDERER=wgpu`
          </div>
        </div>
      </header>
      <SessionOverview
        activePaneId={workspace.focusedPaneId}
        agentUiBySession={agentUiBySession}
        onFocusSession={(sessionId) => {
          const pane = Object.values(workspace.panes).find((entry) => entry.sessionId === sessionId);
          if (!pane) return;
          setWorkspace((current) => (current ? focusPane(current, pane.id) : current));
        }}
        onKillSession={(sessionId) => {
          const pane = Object.values(workspace.panes).find((entry) => entry.sessionId === sessionId);
          if (!pane) return;
          void handleClose(pane.id);
        }}
        onOpenRecording={(sessionId) => {
          void readRecording(sessionId)
            .then((contents) => setRecordingPreview(contents))
            .catch((error) => console.error("failed to read recording", error));
        }}
        onRestartSession={(sessionId) => {
          void handleRestartSession(sessionId);
        }}
        onLauncher={() => setLauncherOpen(true)}
        recordings={recordings}
        recentBusEvents={recentBusEvents}
        rules={rules}
        rulesError={rulesError}
        sessions={Object.values(sessionInfoById)}
        workspace={workspace}
      />
      <div style={{ minHeight: 0, padding: 12 }}>
        {renderLayout(
          workspace.layout,
          workspace,
          sessionInfoById,
          agentUiBySession,
          restoredSnapshotsBySessionId,
          handleSplit,
          handleClose,
          handleResizeSplit,
          (paneId) => setWorkspace((current) => (current ? focusPane(current, paneId) : current)),
          handleTerminalSnapshot,
          (sessionId, approvalId, choice) => {
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
        )}
      </div>
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
      {recordingPreview && (
        <RecordingPreviewModal contents={recordingPreview} onClose={() => setRecordingPreview(null)} />
      )}
      <ToastStack notifications={toastNotifications} sessionInfoById={sessionInfoById} />
    </div>
  );
}

function renderLayout(
  node: LayoutNode,
  workspace: WorkspaceState,
  sessionInfoById: Record<string, SessionInfo>,
  agentUiBySession: Record<string, AgentSessionState>,
  restoredSnapshotsBySessionId: Record<string, PersistedTerminalSnapshot>,
  onSplit: (paneId: string, direction: SplitDirection) => Promise<void>,
  onClose: (paneId: string) => Promise<void>,
  onResize: (
    path: LayoutPath,
    handleIndex: number,
    delta: number,
    baseWeights: number[],
  ) => void,
  onFocus: (paneId: string) => void,
  onSnapshot: (sessionId: string, snapshot: PersistedTerminalSnapshot) => void,
  onApproval: (sessionId: string, approvalId: string, choice: string) => void,
  path: LayoutPath = [],
): ReactNode {
  if (node.type === "leaf") {
    const pane = workspace.panes[node.paneId];
    if (!pane) return null;
    const session = sessionInfoById[pane.sessionId];
    const agent = agentUiBySession[pane.sessionId] ?? emptyAgentSessionState();
    const summary =
      agent.status?.detail ??
      agent.status?.phase ??
      agent.progress?.message ??
      agent.finished?.summary ??
      session?.prompt_summary ??
      "interactive terminal";
    const blocked = agent.pendingApprovals.length > 0;
    const showInspector =
      agent.toolCalls.length > 0 ||
      agent.fileEdits.length > 0 ||
      agent.widgets.length > 0 ||
      agent.pendingApprovals.length > 0;

    return (
      <section
        key={pane.id}
        style={{
          minHeight: 0,
          display: "grid",
          gridTemplateRows: "auto 1fr auto",
          border: workspace.focusedPaneId === pane.id ? "1px solid #5c7bac" : "1px solid #1d2230",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow:
            workspace.focusedPaneId === pane.id
              ? "0 0 0 1px rgba(92,123,172,0.25), 0 18px 60px rgba(0,0,0,0.35)"
              : "0 12px 48px rgba(0,0,0,0.25)",
          background: "#0f1219",
          position: "relative",
        }}
      >
        <PaneHeader
          connected={session?.control_connected ?? false}
          focused={workspace.focusedPaneId === pane.id}
          onClose={() => void onClose(pane.id)}
          onSplit={onSplit}
          paneId={pane.id}
          summary={summary}
          title={pane.title}
          totalPanes={Object.keys(workspace.panes).length}
        />
        <div
          style={{
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: showInspector ? "minmax(0, 1fr) 320px" : "minmax(0, 1fr)",
          }}
        >
          <TerminalViewport
            blocked={blocked}
            focused={workspace.focusedPaneId === pane.id}
            onActivate={() => onFocus(pane.id)}
            onSnapshotChange={(snapshot) => onSnapshot(pane.sessionId, snapshot)}
            restoredSnapshot={restoredSnapshotsBySessionId[pane.sessionId] ?? null}
            sessionId={pane.sessionId}
          />
          {showInspector && <AgentInspector agent={agent} />}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            padding: "6px 10px",
            borderTop: "1px solid #1d2230",
            fontFamily: "monospace",
            fontSize: 11,
            color: "#7b8498",
          }}
        >
          <span>{agent.progress ? `${agent.progress.pct}%` : "ready"}</span>
          <span>{agent.toolCalls.length} tool calls</span>
          <span>{session?.worktree_path ? "isolated worktree" : "shared workspace"}</span>
        </div>
        {blocked && (
          <ApprovalOverlay
            approval={agent.pendingApprovals[0]!}
            additionalCount={agent.pendingApprovals.length - 1}
            onChoice={(choice) =>
              onApproval(pane.sessionId, agent.pendingApprovals[0]!.id, choice)
            }
          />
        )}
      </section>
    );
  }

  const handleSizePx = 10;
  const template =
    node.direction === "horizontal"
      ? { gridTemplateColumns: buildSplitTemplate(node.weights, handleSizePx) }
      : { gridTemplateRows: buildSplitTemplate(node.weights, handleSizePx) };
  const totalWeight = node.weights.reduce((sum, weight) => sum + weight, 0);

  return (
    <div
      style={{
        minHeight: 0,
        height: "100%",
        display: "grid",
        ...template,
      }}
    >
      {node.children.flatMap((child, index) => {
        const childNode = (
          <div
            key={`${path.join("-") || "root"}-child-${index}`}
            style={{ minHeight: 0, minWidth: 0 }}
          >
            {renderLayout(
              child,
              workspace,
              sessionInfoById,
              agentUiBySession,
              restoredSnapshotsBySessionId,
              onSplit,
              onClose,
              onResize,
              onFocus,
              onSnapshot,
              onApproval,
              [...path, index],
            )}
          </div>
        );

        if (index === node.children.length - 1) {
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
  return (
    <div
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
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
        };

        handleElement.addEventListener("pointermove", handleMove as EventListener);
        handleElement.addEventListener("pointerup", cleanup);
        handleElement.addEventListener("pointercancel", cleanup);
      }}
      role="separator"
      style={{
        background:
          direction === "horizontal"
            ? "linear-gradient(180deg, transparent, rgba(92,123,172,0.6), transparent)"
            : "linear-gradient(90deg, transparent, rgba(92,123,172,0.6), transparent)",
        cursor: direction === "horizontal" ? "col-resize" : "row-resize",
        position: "relative",
        touchAction: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: direction === "horizontal" ? "10px 3px" : "3px 10px",
          borderRadius: 999,
          background: "rgba(92,123,172,0.24)",
        }}
      />
    </div>
  );
}

function PaneHeader({
  connected,
  focused,
  onClose,
  onSplit,
  paneId,
  summary,
  title,
  totalPanes,
}: {
  connected: boolean;
  focused: boolean;
  onClose: () => void;
  onSplit: (paneId: string, direction: SplitDirection) => Promise<void>;
  paneId: string;
  summary: string;
  title: string;
  totalPanes: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 10px",
        borderBottom: "1px solid #1d2230",
        background: "rgba(13, 16, 24, 0.95)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 999,
            background: connected ? "#6dc98b" : focused ? "#7fb0ff" : "#7b8498",
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 12,
              color: "#d6d9e0",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#7b8498",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 360,
            }}
          >
            {summary}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <ChromeButton label="H" onClick={() => void onSplit(paneId, "horizontal")} />
        <ChromeButton label="V" onClick={() => void onSplit(paneId, "vertical")} />
        <ChromeButton disabled={totalPanes === 1} label="X" onClick={onClose} />
      </div>
    </div>
  );
}

function AgentInspector({ agent }: { agent: AgentSessionState }) {
  const latestWidget = agent.widgets.at(-1);
  return (
    <aside
      style={{
        borderLeft: "1px solid #1d2230",
        background: "#0d1016",
        padding: 12,
        overflow: "auto",
        display: "grid",
        gap: 12,
      }}
    >
      <InspectorBlock label="Status">
        <div>{agent.status?.phase ?? "idle"}</div>
        {agent.status?.detail && <div style={{ color: "#9aa3b7" }}>{agent.status.detail}</div>}
        {agent.progress && <div>{agent.progress.pct}% · {agent.progress.message}</div>}
      </InspectorBlock>
      {agent.toolCalls.length > 0 && (
        <InspectorBlock label="Tool Calls">
          {agent.toolCalls.slice(-6).map((call) => (
            <div key={call.id} style={{ borderBottom: "1px solid #1d2230", paddingBottom: 6 }}>
              <div>{call.name}</div>
              <div style={{ color: "#9aa3b7" }}>{JSON.stringify(call.args)}</div>
              {call.result !== undefined && (
                <div style={{ color: "#77d196" }}>{JSON.stringify(call.result)}</div>
              )}
              {call.error && <div style={{ color: "#ff8e8e" }}>{call.error}</div>}
            </div>
          ))}
        </InspectorBlock>
      )}
      {agent.fileEdits.length > 0 && (
        <InspectorBlock label="Files Changed">
          {agent.fileEdits.slice(-6).map((file) => (
            <div key={`${file.kind}-${file.path}`}>{file.kind.toUpperCase()} {file.path}</div>
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

function ApprovalOverlay({
  approval,
  additionalCount,
  onChoice,
}: {
  approval: { id: string; message: string; options: string[] };
  additionalCount: number;
  onChoice: (choice: string) => void;
}) {
  const options = approval.options.length > 0 ? approval.options : ["Allow", "Deny"];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(5, 8, 14, 0.72)",
        backdropFilter: "blur(6px)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          background: "#0e121a",
          border: "1px solid #293042",
          borderRadius: 18,
          padding: 20,
          display: "grid",
          gap: 14,
          boxShadow: "0 30px 80px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: "#7b8498" }}>
          Agent Approval
        </div>
        <div style={{ fontSize: 16, lineHeight: 1.5 }}>{approval.message}</div>
        {additionalCount > 0 && (
          <div style={{ fontSize: 12, color: "#7b8498" }}>
            {additionalCount} additional approval request(s) queued for this pane.
          </div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {options.map((option) => (
            <button
              key={option}
              onClick={() => onChoice(option)}
              style={{
                borderRadius: 10,
                border: "1px solid #33405a",
                background: option.toLowerCase().includes("deny") ? "#2a1820" : "#162235",
                color: "#d6d9e0",
                padding: "10px 16px",
                cursor: "pointer",
              }}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
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
                style={{ textAlign: "left", borderBottom: "1px solid #293042", paddingBottom: 6 }}
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
                <td key={cellIndex} style={{ paddingTop: 6, color: "#c4cbda" }}>
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
  return <div style={{ color: "#9aa3b7", fontSize: 12 }}>Unsupported widget payload</div>;
}

function SessionOverview({
  activePaneId,
  agentUiBySession,
  onFocusSession,
  onKillSession,
  onOpenRecording,
  onRestartSession,
  onLauncher,
  recordings,
  recentBusEvents,
  rules,
  rulesError,
  sessions,
  workspace,
}: {
  activePaneId: string | null;
  agentUiBySession: Record<string, AgentSessionState>;
  onFocusSession: (sessionId: string) => void;
  onKillSession: (sessionId: string) => void;
  onOpenRecording: (sessionId: string) => void;
  onRestartSession: (sessionId: string) => void;
  onLauncher: () => void;
  recordings: Record<string, RecordingInfo>;
  recentBusEvents: BusEvent[];
  rules: RuleDefinition[];
  rulesError: string | null;
  sessions: SessionInfo[];
  workspace: WorkspaceState;
}) {
  const triggerCounts = recentRuleTriggerCounts(recentBusEvents);

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        overflowX: "auto",
        padding: "10px 16px",
        borderBottom: "1px solid #1d2230",
        background: "rgba(8, 10, 15, 0.72)",
      }}
    >
      <div style={{ display: "flex", gap: 10 }}>
        {sessions.map((session) => {
          const pane = Object.values(workspace.panes).find(
            (entry) => entry.sessionId === session.session_id,
          );
          const active = pane?.id === activePaneId;
          const agent = agentUiBySession[session.session_id];
          const phase =
            agent?.status?.phase ?? agent?.finished?.summary ?? session.prompt_summary ?? "idle";
          const hasRecording = Boolean(recordings[session.session_id]);
          return (
            <div
              key={session.session_id}
              style={{
                flexShrink: 0,
                minWidth: 240,
                borderRadius: 12,
                border: active ? "1px solid #5c7bac" : "1px solid #273043",
                background: active ? "#131b2a" : "#10141d",
                color: "#d6d9e0",
                padding: "10px 12px",
                display: "grid",
                gap: 10,
              }}
            >
              <button
                onClick={() => onFocusSession(session.session_id)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "inherit",
                  padding: 0,
                  margin: 0,
                  textAlign: "left",
                  cursor: "pointer",
                }}
                type="button"
              >
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>{session.title}</div>
                <div style={{ fontSize: 11, color: "#7b8498" }}>{phase}</div>
              </button>
              {session.worktree_path && (
                <div style={{ fontSize: 10, color: "#7fb0ff" }}>isolated worktree</div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <button
                  onClick={() => onFocusSession(session.session_id)}
                  style={secondaryButtonStyle}
                  type="button"
                >
                  Focus
                </button>
                <button
                  onClick={() => onRestartSession(session.session_id)}
                  style={secondaryButtonStyle}
                  type="button"
                >
                  Restart
                </button>
                <button
                  disabled={!hasRecording}
                  onClick={() => onOpenRecording(session.session_id)}
                  style={secondaryButtonStyle}
                  type="button"
                >
                  Recording
                </button>
                <button
                  onClick={() => onKillSession(session.session_id)}
                  style={{ ...secondaryButtonStyle, background: "#22161c", borderColor: "#56303d" }}
                  type="button"
                >
                  Kill
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {recentBusEvents.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            minWidth: 300,
            borderRadius: 12,
            border: "1px solid #273043",
            background: "#0d1118",
            color: "#d6d9e0",
            padding: "10px 12px",
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontFamily: "monospace", fontSize: 12 }}>Event Bus</div>
          {recentBusEvents.slice(-6).map((event, index) => (
            <div key={`${event.type}-${index}`} style={{ fontSize: 11, color: "#7b8498" }}>
              {event.type} {event.session_id ? `· ${event.session_id}` : ""}
            </div>
          ))}
        </div>
      )}
      <div
        style={{
          flexShrink: 0,
          minWidth: 320,
          borderRadius: 12,
          border: "1px solid #273043",
          background: "#0d1118",
          color: "#d6d9e0",
          padding: "10px 12px",
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontFamily: "monospace", fontSize: 12 }}>Rules</div>
          <div style={{ fontSize: 11, color: "#7b8498" }}>
            {rulesError ? "load failed" : `${rules.length} loaded`}
          </div>
        </div>
        {rulesError ? (
          <div style={{ fontSize: 11, color: "#ff8e8e" }}>{rulesError}</div>
        ) : rules.length === 0 ? (
          <div style={{ fontSize: 11, color: "#7b8498" }}>
            No orchestration rules are configured in <code>agents.toml</code>.
          </div>
        ) : (
          rules.slice(0, 4).map((rule) => {
            const triggerCount = triggerCounts[rule.name] ?? 0;
            return (
              <div
                key={rule.name}
                style={{
                  borderTop: "1px solid #1d2230",
                  paddingTop: 8,
                  display: "grid",
                  gap: 4,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 11, color: "#d6d9e0" }}>{rule.name}</div>
                  <div style={{ fontSize: 10, color: triggerCount > 0 ? "#7fb0ff" : "#7b8498" }}>
                    {triggerCount > 0 ? `${triggerCount} recent trigger${triggerCount === 1 ? "" : "s"}` : "idle"}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#7b8498" }}>{summarizeRuleTrigger(rule)}</div>
                <div style={{ fontSize: 11, color: "#9aa3b7" }}>{summarizeRuleAction(rule)}</div>
              </div>
            );
          })
        )}
      </div>
      <button
        onClick={onLauncher}
        style={{
          flexShrink: 0,
          borderRadius: 12,
          border: "1px dashed #394357",
          background: "#0d1118",
          color: "#9aa3b7",
          padding: "10px 14px",
          cursor: "pointer",
        }}
        type="button"
      >
        New Agent
      </button>
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
        background: "rgba(4, 6, 10, 0.68)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(720px, 100%)",
          background: "#0d1118",
          borderRadius: 18,
          border: "1px solid #293042",
          padding: 20,
          display: "grid",
          gap: 16,
          boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: "#7b8498" }}>
              Launch Agent
            </div>
            <div style={{ fontSize: 11, color: "#7b8498" }}>
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
                  borderRadius: 12,
                  border:
                    selectedAgentId === agent.id ? "1px solid #5c7bac" : "1px solid #273043",
                  background: selectedAgentId === agent.id ? "#131b2a" : "#10141d",
                  color: "#d6d9e0",
                  padding: "10px 12px",
                  textAlign: "left",
                  cursor: "pointer",
                }}
                type="button"
              >
                <div>{agent.name}</div>
                <div style={{ fontSize: 11, color: "#7b8498" }}>{agent.command}</div>
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

function RecordingPreviewModal({
  contents,
  onClose,
}: {
  contents: string;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(4, 6, 10, 0.68)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 60,
      }}
    >
      <div
        style={{
          width: "min(900px, 100%)",
          maxHeight: "80vh",
          background: "#0d1118",
          borderRadius: 18,
          border: "1px solid #293042",
          padding: 20,
          display: "grid",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: "#7b8498" }}>
            Session Recording
          </div>
          <ChromeButton label="X" onClick={onClose} />
        </div>
        <RecordingReplay contents={contents} />
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
        top: 88,
        right: 20,
        display: "grid",
        gap: 10,
        zIndex: 50,
      }}
    >
      {notifications.slice(-4).map(({ sessionId, notification }, index) => (
        <div
          key={`${sessionId}-${index}-${notification.message}`}
          style={{
            minWidth: 260,
            borderRadius: 12,
            border: "1px solid #273043",
            background: "#10141d",
            padding: "10px 12px",
            boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ fontSize: 11, color: "#7b8498" }}>
            {sessionInfoById[sessionId]?.title ?? sessionId}
          </div>
          <div style={{ fontSize: 12, color: "#d6d9e0" }}>{notification.message}</div>
        </div>
      ))}
    </div>
  );
}

function InspectorBlock({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section style={{ display: "grid", gap: 8, fontSize: 12 }}>
      <div style={{ color: "#7b8498", textTransform: "uppercase", letterSpacing: 1 }}>
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
        width: 26,
        height: 26,
        borderRadius: 8,
        border: "1px solid #2a3140",
        background: disabled ? "#151922" : "#161b26",
        color: disabled ? "#485065" : "#cdd3df",
        cursor: disabled ? "not-allowed" : "pointer",
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
  color: "#c4cbda",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid #293042",
  background: "#10141d",
  color: "#d6d9e0",
  padding: 12,
  resize: "vertical",
  fontFamily: "inherit",
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid #293042",
  background: "#10141d",
  color: "#d6d9e0",
  padding: "10px 12px",
};

const secondaryButtonStyle: CSSProperties = {
  borderRadius: 10,
  border: "1px solid #293042",
  background: "#10141d",
  color: "#d6d9e0",
  padding: "10px 14px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  borderRadius: 10,
  border: "1px solid #3a527d",
  background: "#1a2a45",
  color: "#e6ebf5",
  padding: "10px 14px",
  cursor: "pointer",
};
