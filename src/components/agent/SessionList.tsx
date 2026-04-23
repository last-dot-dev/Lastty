import {
  deriveAgentStatus,
  deriveAgentType,
  deriveTaskName,
} from "../../app/agentDerived";
import { useAgentSession } from "../../app/agentStore";
import { formatRelative } from "../../lib/relativeTime";
import type { HistoryEntry, SessionInfo } from "../../lib/ipc";

export interface SessionListRow {
  key: string;
  sessionId: string;
  paneId: string | null;
  taskName: string;
  agentId: string;
  projectRoot: string;
  projectLabel: string;
  startedAtUnixMs: number;
  dormant: boolean;
  historyEntry: HistoryEntry | null;
}

export function buildSessionListRows(
  sessionInfoById: Record<string, SessionInfo>,
  sessionIdToPaneId: Record<string, string>,
  projectRootBySessionId: Record<string, string> = {},
  historyEntries: HistoryEntry[] = [],
): SessionListRow[] {
  const liveSessionIds = new Set(Object.keys(sessionInfoById));
  const liveAgentSessionIds = new Set(
    Object.values(sessionInfoById)
      .map((info) => info.session_id)
      .filter((id): id is string => Boolean(id)),
  );

  const liveRows: SessionListRow[] = Object.values(sessionInfoById).map((info) => {
    const projectRoot =
      projectRootBySessionId[info.session_id] ??
      inferProjectRoot(info.worktree_path, info.cwd);
    return {
      key: `live:${info.session_id}`,
      sessionId: info.session_id,
      paneId: sessionIdToPaneId[info.session_id] ?? null,
      taskName: shortTaskName(info, projectRoot),
      agentId: deriveAgentType(info),
      projectRoot,
      projectLabel: projectLabel(projectRoot),
      startedAtUnixMs: info.started_at_unix_ms,
      dormant: false,
      historyEntry: null,
    };
  });

  const dormantRows: SessionListRow[] = historyEntries
    .filter((entry) => {
      if (liveSessionIds.has(entry.session_id)) return false;
      if (entry.agent_session_id && liveAgentSessionIds.has(entry.agent_session_id))
        return false;
      return true;
    })
    .map((entry) => {
      const projectRoot = inferProjectRoot(entry.worktree_path, entry.cwd);
      return {
        key: `hist:${entry.session_id}`,
        sessionId: entry.session_id,
        paneId: null,
        taskName: shortHistoryTaskName(entry, projectRoot),
        agentId: entry.agent_id ?? "shell",
        projectRoot,
        projectLabel: projectLabel(projectRoot),
        startedAtUnixMs: entry.last_event_ms || entry.started_at_ms,
        dormant: true,
        historyEntry: entry,
      };
    });

  return [...liveRows, ...dormantRows].sort(
    (a, b) => b.startedAtUnixMs - a.startedAtUnixMs,
  );
}

export function groupRowsByProject(
  rows: SessionListRow[],
): Array<{ projectRoot: string; projectLabel: string; rows: SessionListRow[] }> {
  const order: string[] = [];
  const groups = new Map<
    string,
    { projectLabel: string; rows: SessionListRow[] }
  >();
  for (const row of rows) {
    const existing = groups.get(row.projectRoot);
    if (existing) {
      existing.rows.push(row);
    } else {
      order.push(row.projectRoot);
      groups.set(row.projectRoot, { projectLabel: row.projectLabel, rows: [row] });
    }
  }
  return order.map((projectRoot) => ({
    projectRoot,
    projectLabel: groups.get(projectRoot)!.projectLabel,
    rows: groups.get(projectRoot)!.rows,
  }));
}

function inferProjectRoot(
  worktreePath: string | null | undefined,
  cwd: string | null | undefined,
): string {
  const path = worktreePath || cwd || "";
  const match = path.match(/^(.*?)\/\.(lastty|pane)-worktrees\//);
  if (match) return match[1]!;
  return path.replace(/\/+$/, "");
}

function projectLabel(projectRoot: string): string {
  if (!projectRoot) return "shell";
  const trimmed = projectRoot.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const base = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return base || trimmed;
}

const TASK_NAME_MAX = 40;

function shortTaskName(info: SessionInfo, projectRoot: string): string {
  return finishShortName(deriveTaskName(info), projectRoot);
}

function shortHistoryTaskName(entry: HistoryEntry, projectRoot: string): string {
  const summary = entry.prompt_summary?.trim();
  const raw = summary || entry.title?.trim() || "shell";
  return finishShortName(raw, projectRoot);
}

function finishShortName(raw: string, projectRoot: string): string {
  const firstLine = raw.trim().split(/\r?\n/)[0]!.trim();
  const stripped = stripPathPrefix(firstLine, projectRoot);
  if (stripped.length <= TASK_NAME_MAX) return stripped;
  return `${stripped.slice(0, TASK_NAME_MAX - 1)}…`;
}

function stripPathPrefix(name: string, projectRoot: string): string {
  if (
    projectRoot &&
    (name === projectRoot || name.startsWith(`${projectRoot}/`))
  ) {
    const rel = name.slice(projectRoot.length).replace(/^\/+/, "");
    return rel || projectLabel(projectRoot);
  }
  if (name.startsWith("/") || name.startsWith("~/")) {
    const trimmed = name.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
  }
  return name;
}

export default function SessionList({
  rows,
  onFocusPane,
  onResumeHistory,
  nowMs,
}: {
  rows: SessionListRow[];
  onFocusPane: (paneId: string) => void;
  onResumeHistory: (entry: HistoryEntry) => void;
  nowMs: number;
}) {
  if (rows.length === 0) {
    return <div className="agent-sidebar__empty">no sessions yet</div>;
  }
  const groups = groupRowsByProject(rows);
  return (
    <div className="agent-session-list">
      {groups.map((group) => (
        <div key={group.projectRoot} className="agent-session-list__group">
          <div
            className="agent-session-list__group-header"
            title={group.projectRoot}
          >
            {group.projectLabel}
          </div>
          {group.rows.map((row) => (
            <SessionRow
              key={row.key}
              row={row}
              onFocusPane={onFocusPane}
              onResumeHistory={onResumeHistory}
              nowMs={nowMs}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SessionRow({
  row,
  onFocusPane,
  onResumeHistory,
  nowMs,
}: {
  row: SessionListRow;
  onFocusPane: (paneId: string) => void;
  onResumeHistory: (entry: HistoryEntry) => void;
  nowMs: number;
}) {
  const ui = useAgentSession(row.sessionId);
  const status = row.dormant ? "done" : deriveAgentStatus(ui, false);
  const relative =
    row.startedAtUnixMs > 0
      ? formatRelative(Math.floor(row.startedAtUnixMs / 1000), nowMs)
      : "—";
  const className = `agent-session-list__row${row.dormant ? " is-dormant" : ""}`;
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (row.dormant && row.historyEntry) {
          onResumeHistory(row.historyEntry);
        } else if (row.paneId) {
          onFocusPane(row.paneId);
        }
      }}
      title={row.dormant ? `resume · ${row.taskName}` : row.taskName}
    >
      <span
        className={`agent-dot is-${status}`}
        aria-label={status}
        aria-hidden="true"
      />
      <span className="agent-session-list__task">{row.taskName}</span>
      <span className="agent-session-list__meta">
        {row.agentId} · {relative}
      </span>
    </button>
  );
}
