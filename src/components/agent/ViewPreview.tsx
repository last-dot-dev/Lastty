import type { CSSProperties, ReactNode } from "react";

import type { AgentSessionState } from "../../app/agentUi";
import {
  assignBranchColor,
  deriveAgentStatus,
  deriveProgressPct,
  deriveTaskName,
} from "../../app/agentDerived";
import type { DesktopState, LayoutNode, WorkspaceState } from "../../app/layout";
import type { SessionInfo } from "../../lib/ipc";

export default function ViewPreview({
  desktop,
  workspace,
  sessionInfoById,
  agentUiBySession,
  sessionCreationOrder,
}: {
  desktop: DesktopState;
  workspace: WorkspaceState;
  sessionInfoById: Record<string, SessionInfo>;
  agentUiBySession: Record<string, AgentSessionState>;
  sessionCreationOrder: string[];
}) {
  if (!desktop.layout) {
    return (
      <div className="agent-view-preview is-empty">
        <span>No panes</span>
      </div>
    );
  }

  return (
    <div className="agent-view-preview">
      <div className="agent-view-preview__name">{desktop.name}</div>
      <div className="agent-view-preview__canvas">
        {renderNode(desktop.layout, {
          workspace,
          sessionInfoById,
          agentUiBySession,
          sessionCreationOrder,
        })}
      </div>
    </div>
  );
}

interface Ctx {
  workspace: WorkspaceState;
  sessionInfoById: Record<string, SessionInfo>;
  agentUiBySession: Record<string, AgentSessionState>;
  sessionCreationOrder: string[];
}

function renderNode(node: LayoutNode, ctx: Ctx): ReactNode {
  if (node.type === "leaf") {
    const pane = ctx.workspace.panes[node.paneId];
    if (!pane) return <div className="agent-view-preview__leaf" />;
    const session = ctx.sessionInfoById[pane.sessionId];
    const agent = ctx.agentUiBySession[pane.sessionId];
    const taskName = deriveTaskName(session);
    const progressPct = agent ? deriveProgressPct(agent) : 0;
    const status = deriveAgentStatus(agent, Boolean(agent?.finished));
    const color = assignBranchColor(pane.sessionId, ctx.sessionCreationOrder);
    return (
      <div
        className={`agent-view-preview__leaf ${status === "needs_help" ? "is-needs-help" : ""}`}
      >
        <div className="agent-view-preview__leaf-header">
          <span
            className="agent-view-preview__dot"
            style={{ background: color }}
            aria-hidden
          />
          <span className="agent-view-preview__task" title={taskName}>
            {taskName}
          </span>
          <span className="agent-view-preview__pct">{progressPct}%</span>
        </div>
      </div>
    );
  }

  const totalWeight = node.weights.reduce((sum, weight) => sum + weight, 0);
  const style: CSSProperties = {
    display: "flex",
    flexDirection: node.direction === "horizontal" ? "row" : "column",
    gap: 2,
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  };

  return (
    <div style={style}>
      {node.children.map((child, index) => (
        <div
          key={index}
          style={{
            flex: totalWeight > 0 ? (node.weights[index] ?? 0) / totalWeight : 1,
            minHeight: 0,
            minWidth: 0,
            display: "flex",
          }}
        >
          {renderNode(child, ctx)}
        </div>
      ))}
    </div>
  );
}
