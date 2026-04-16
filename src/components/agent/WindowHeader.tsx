import type { AgentStatus } from "../../app/agentDerived";
import StatusBadge from "./StatusBadge";
import TrafficLights, { type TrafficLightActions } from "./TrafficLights";

export default function WindowHeader({
  taskName,
  branch,
  agentType,
  progressPct,
  status,
  controls,
}: {
  taskName: string;
  branch: string;
  agentType: string;
  progressPct: number;
  status: AgentStatus;
  controls: TrafficLightActions;
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
    >
      <TrafficLights {...controls} />
      <span className="agent-window-header__task" title={taskName}>
        {taskName}
      </span>
      <span className="agent-window-header__branch">{branch}</span>
      <span className="agent-window-header__agent">{agentType}</span>
      <span className={`agent-window-header__pct ${pctCls}`}>{progressPct}%</span>
      <StatusBadge status={status} />
    </div>
  );
}
