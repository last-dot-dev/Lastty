import type { AgentStatus } from "../../app/agentDerived";

export default function ProgressBar({
  pct,
  status,
}: {
  pct: number;
  status: AgentStatus;
}) {
  const cls =
    status === "needs_help" ? "is-needs-help" : status === "done" ? "is-done" : "is-plan";
  return (
    <div className="agent-progress" aria-hidden>
      <div className={`agent-progress__fill ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
