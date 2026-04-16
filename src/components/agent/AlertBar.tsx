export interface BlockedSessionRef {
  sessionId: string;
  taskName: string;
}

export default function AlertBar({
  blocked,
  onJump,
}: {
  blocked: BlockedSessionRef[];
  onJump: (sessionId: string) => void;
}) {
  if (blocked.length === 0) return null;
  return (
    <div className="agent-alert-bar" role="status">
      <span className="agent-dot is-needs-help" style={{ background: "var(--status-help-dot)" }} />
      <span className="agent-alert-bar__message">
        {blocked.length} agent{blocked.length === 1 ? "" : "s"} waiting for your input
      </span>
      <div className="agent-alert-bar__nav">
        {blocked.map((b) => (
          <button
            type="button"
            key={b.sessionId}
            className="agent-alert-bar__chip"
            onClick={() => onJump(b.sessionId)}
          >
            {b.taskName} ↓
          </button>
        ))}
      </div>
    </div>
  );
}
