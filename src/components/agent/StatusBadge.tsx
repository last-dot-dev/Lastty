import type { AgentStatus } from "../../app/agentDerived";

const LABEL: Record<AgentStatus, string> = {
  plan: "running",
  needs_help: "needs help",
  done: "done",
};

export default function StatusBadge({ status }: { status: AgentStatus }) {
  const cls =
    status === "needs_help" ? "is-needs-help" : status === "done" ? "is-done" : "is-plan";
  return <span className={`agent-status-badge ${cls}`}>{LABEL[status]}</span>;
}
