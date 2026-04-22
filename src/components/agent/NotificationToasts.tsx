import { useEffect, useState } from "react";
import { useVisibleToasts } from "../../app/agentStore";
import type { SessionInfo } from "../../lib/ipc";

export function NotificationToasts({
  sessionInfoById,
}: {
  sessionInfoById: Record<string, SessionInfo>;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const toasts = useVisibleToasts(clock);
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 14,
        right: 14,
        display: "grid",
        gap: 8,
        zIndex: 50,
      }}
    >
      {toasts.slice(-4).map(({ sessionId, notification }, index) => (
        <div
          key={`${sessionId}-${index}-${notification.message}`}
          style={{
            minWidth: 240,
            borderRadius: "var(--border-radius-md)",
            border: "0.5px solid var(--color-border-secondary)",
            background: "var(--color-background-primary)",
            color: "var(--color-text-primary)",
            padding: "8px 10px",
            boxShadow: "var(--elev-shadow)",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
            {sessionInfoById[sessionId]?.title ?? sessionId}
          </div>
          <div style={{ fontSize: 12 }}>{notification.message}</div>
        </div>
      ))}
    </div>
  );
}
