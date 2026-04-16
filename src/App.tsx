import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { sendKeyEvent } from "./lib/ipc";

interface AgentPayload {
  session_id: string;
  message: unknown;
}

function App() {
  const [agentMessages, setAgentMessages] = useState<AgentPayload[]>([]);

  useEffect(() => {
    const unlisten = listen<AgentPayload>("agent:ui", (event) => {
      setAgentMessages((prev) => [...prev.slice(-99), event.payload]);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      sendKeyEvent(e.key, e.code, e.ctrlKey, e.altKey, e.shiftKey, e.metaKey);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        background: "transparent",
      }}
    >
      {agentMessages.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            right: 16,
            padding: "8px 12px",
            background: "rgba(0,0,0,0.8)",
            color: "#0f0",
            fontFamily: "monospace",
            fontSize: 12,
            borderRadius: 4,
            maxHeight: 200,
            overflow: "auto",
            pointerEvents: "auto",
          }}
        >
          <div>Agent Messages ({agentMessages.length})</div>
          {agentMessages.slice(-5).map((msg, i) => (
            <pre key={i}>{JSON.stringify(msg, null, 2)}</pre>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
