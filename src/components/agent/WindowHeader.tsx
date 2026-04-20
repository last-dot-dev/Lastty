import type { AgentStatus } from "../../app/agentDerived";
import StatusBadge from "./StatusBadge";
import TrafficLights, { type TrafficLightActions } from "./TrafficLights";

function HistoryIcon() {
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
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

export default function WindowHeader({
  taskName,
  agentType,
  progressPct,
  status,
  controls,
  onDragStart,
  onDragEnd,
  draggable = false,
  onHistoryClick,
  historyActive = false,
}: {
  taskName: string;
  agentType: string;
  progressPct: number;
  status: AgentStatus;
  controls: TrafficLightActions;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void;
  draggable?: boolean;
  onHistoryClick?: () => void;
  historyActive?: boolean;
}) {
  const pctCls =
    status === "needs_help"
      ? "is-needs-help"
      : status === "done"
        ? "is-done"
        : "is-plan";
  return (
    <div
      className={`agent-window-header ${status === "needs_help" ? "is-needs-help" : ""}`}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <TrafficLights {...controls} />
      <span className="agent-window-header__task" title={taskName}>
        {taskName}
      </span>
      <span className="agent-window-header__agent">{agentType}</span>
      <span className={`agent-window-header__pct ${pctCls}`}>{progressPct}%</span>
      <StatusBadge status={status} />
      {onHistoryClick && (
        <button
          type="button"
          className={`agent-window-header__history ${historyActive ? "is-active" : ""}`}
          aria-label="history"
          title="History"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onHistoryClick();
          }}
        >
          <HistoryIcon />
        </button>
      )}
    </div>
  );
}
