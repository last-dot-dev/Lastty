import {
  deriveAgentStatus,
  deriveAgentType,
  deriveTaskName,
} from "../../app/agentDerived";
import { useAgentSession } from "../../app/agentStore";
import { formatRelative } from "../../lib/relativeTime";
import type { SessionInfo } from "../../lib/ipc";

export interface SessionListRow {
  sessionId: string;
  paneId: string | null;
  taskName: string;
  agentId: string;
  worktreeBranchName: string;
  startedAtMs: number;
}

export function buildSessionListRows(
  sessionInfoById: Record<string, SessionInfo>,
  sessionIdToPaneId: Record<string, string>,
): SessionListRow[] {
  return Object.values(sessionInfoById)
    .map((info) => ({
      sessionId: info.session_id,
      paneId: sessionIdToPaneId[info.session_id] ?? null,
      taskName: deriveTaskName(info),
      agentId: deriveAgentType(info),
      worktreeBranchName: branchFromPath(info.worktree_path || info.cwd),
      startedAtMs: info.started_at_ms,
    }))
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
}

export function groupRowsByBranch(
  rows: SessionListRow[],
): Array<{ branch: string; rows: SessionListRow[] }> {
  const order: string[] = [];
  const groups = new Map<string, SessionListRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.worktreeBranchName);
    if (existing) {
      existing.push(row);
    } else {
      order.push(row.worktreeBranchName);
      groups.set(row.worktreeBranchName, [row]);
    }
  }
  return order.map((branch) => ({ branch, rows: groups.get(branch)! }));
}

function branchFromPath(path: string | null | undefined): string {
  if (!path) return "shell";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

export default function SessionList({
  rows,
  onFocusPane,
  nowMs,
}: {
  rows: SessionListRow[];
  onFocusPane: (paneId: string) => void;
  nowMs: number;
}) {
  if (rows.length === 0) {
    return <div className="agent-sidebar__empty">no sessions yet</div>;
  }
  const groups = groupRowsByBranch(rows);
  return (
    <div className="agent-session-list">
      {groups.map((group) => (
        <div key={group.branch} className="agent-session-list__group">
          <div className="agent-session-list__group-header">{group.branch}</div>
          {group.rows.map((row) => (
            <SessionRow
              key={row.sessionId}
              row={row}
              onFocusPane={onFocusPane}
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
  nowMs,
}: {
  row: SessionListRow;
  onFocusPane: (paneId: string) => void;
  nowMs: number;
}) {
  const ui = useAgentSession(row.sessionId);
  const status = deriveAgentStatus(ui, false);
  const disabled = row.paneId === null;
  return (
    <button
      type="button"
      className="agent-session-list__row"
      disabled={disabled}
      onClick={() => {
        if (row.paneId) onFocusPane(row.paneId);
      }}
      title={row.taskName}
    >
      <span
        className={`agent-dot is-${status}`}
        aria-label={status}
        aria-hidden="true"
      />
      <span className="agent-session-list__task">{row.taskName}</span>
      <span className="agent-session-list__meta">
        {row.agentId} · {formatRelative(Math.floor(row.startedAtMs / 1000), nowMs)}
      </span>
    </button>
  );
}
