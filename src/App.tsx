import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { sendKeyEvent } from "./lib/ipc";

interface AgentPayload {
  session_id: string;
  message: unknown;
}

interface PerfPayload {
  snapshot_ms: number;
  render_ms: number;
  frame_ms: number;
  cache_ms: number;
  rect_ms: number;
  prepare_ms: number;
  gpu_ms: number;
  fps: number;
  changed_lines: number;
  cached_lines: number;
  text_areas: number;
  wakeups: number;
  generation: number;
  pending_updates: number;
}

function App() {
  const [agentMessages, setAgentMessages] = useState<AgentPayload[]>([]);
  const [perfStats, setPerfStats] = useState<PerfPayload | null>(null);

  useEffect(() => {
    const unlisten = listen<AgentPayload>("agent:ui", (event) => {
      setAgentMessages((prev) => [...prev.slice(-99), event.payload]);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<PerfPayload>("perf:stats", (event) => {
      setPerfStats(event.payload);
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
      {perfStats && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            padding: "8px 10px",
            background: "rgba(0,0,0,0.8)",
            color: "#9ef",
            fontFamily: "monospace",
            fontSize: 12,
            borderRadius: 4,
            minWidth: 220,
            pointerEvents: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          <div>
            {`frame ${perfStats.frame_ms.toFixed(1)}ms  fps ${perfStats.fps.toFixed(1)}`}
          </div>
          <div>
            {`snapshot ${perfStats.snapshot_ms.toFixed(1)}ms  render ${perfStats.render_ms.toFixed(1)}ms`}
          </div>
          <div>
            {`cache ${perfStats.cache_ms.toFixed(1)}  rect ${perfStats.rect_ms.toFixed(1)}  prep ${perfStats.prepare_ms.toFixed(1)}  gpu ${perfStats.gpu_ms.toFixed(1)}`}
          </div>
          <div>
            {`changed ${perfStats.changed_lines}  cached ${perfStats.cached_lines}  text ${perfStats.text_areas}`}
          </div>
          <div>{`wakeups ${perfStats.wakeups}  pending ${perfStats.pending_updates}`}</div>
          <div>{`generation ${perfStats.generation}`}</div>
        </div>
      )}
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
