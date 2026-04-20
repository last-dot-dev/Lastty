import type { CSSProperties } from "react";

import type { AgentStatus } from "../../app/agentDerived";
import StatusBadge from "./StatusBadge";

export interface SessionRow {
  sessionId: string;
  paneId: string | null;
  title: string;
  status: AgentStatus;
  focused: boolean;
  merged: boolean;
  unread: boolean;
}

export default function SessionList({
  rows,
  onFocus,
  style,
}: {
  rows: SessionRow[];
  onFocus: (paneId: string) => void;
  style?: CSSProperties;
}) {
  return (
    <div className="agent-sidebar__section is-top" style={style}>
      <div className="agent-sidebar__label">Sessions</div>
      <div className="agent-sidebar__sessions">
        {rows.length === 0 && (
          <div
            style={{
              padding: "6px 12px",
              color: "var(--color-text-tertiary)",
              fontSize: 11,
            }}
          >
            no sessions yet
          </div>
        )}
        {rows.map((row) => (
          <button
            key={row.sessionId}
            type="button"
            className={`agent-session-row ${row.focused ? "is-focused" : ""} ${
              row.merged ? "is-merged" : ""
            } ${row.unread && row.status !== "needs_help" ? "is-unread" : ""}`}
            onClick={() => row.paneId && onFocus(row.paneId)}
            disabled={!row.paneId}
          >
            {(row.status === "needs_help" || row.unread) && (
              <span
                className={`agent-dot ${
                  row.status === "needs_help" ? "is-needs-help" : "is-unread"
                }`}
              />
            )}
            <span className="agent-session-row__name">{row.title}</span>
            <StatusBadge status={row.status} />
          </button>
        ))}
      </div>
    </div>
  );
}
