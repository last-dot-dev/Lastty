import type { AgentStatus } from "../../app/agentDerived";

export interface TabEntry {
  paneId: string;
  sessionId: string;
  taskName: string;
  progressPct: number;
  status: AgentStatus;
  color: string;
  reason: "minimized" | "displaced";
}

export default function TabStrip({
  tabs,
  onRestore,
}: {
  tabs: TabEntry[];
  onRestore: (paneId: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="agent-tab-strip" role="toolbar" aria-label="minimized windows">
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.paneId}
          className={`agent-tab ${tab.reason === "displaced" ? "is-displaced" : ""}`}
          onClick={() => onRestore(tab.paneId)}
          title={tab.taskName}
        >
          <span
            className={`agent-dot ${tab.status === "needs_help" ? "is-needs-help" : ""}`}
            style={{ background: tab.color, width: 6, height: 6 }}
          />
          <span className="agent-tab__name">{tab.taskName}</span>
          <span className="agent-tab__pct">{tab.progressPct}%</span>
          {tab.status === "needs_help" && <span className="agent-tab__help">help</span>}
        </button>
      ))}
    </div>
  );
}
