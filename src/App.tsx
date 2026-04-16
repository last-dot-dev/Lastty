import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";


import {
  getPrimarySessionId,
  listSessions,
  sendKeyEvent,
  updatePaneLayout,
  type PaneLayoutEntry,
  type SessionInfo,
} from "./lib/ipc";

interface AgentPayload {
  session_id: string;
  message: unknown;
}

function App() {
  const [agentMessages, setAgentMessages] = useState<AgentPayload[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const paneHostRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      const primary = await getPrimarySessionId().catch(() => null);
      if (cancelled) return;
      if (primary) {
        setSessionId(primary);
        return;
      }
      const sessions = await listSessions().catch(() => [] as SessionInfo[]);
      if (cancelled) return;
      setSessionId(sessions[0]?.session_id ?? null);
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const host = paneHostRef.current;
    if (!host) return;

    let pending: number | null = null;
    let latestRect: DOMRect | null = null;

    const push = () => {
      if (!latestRect) return;
      const entry: PaneLayoutEntry = {
        session_id: sessionId,
        x: latestRect.left,
        y: latestRect.top,
        width: latestRect.width,
        height: latestRect.height,
      };
      updatePaneLayout([entry]).catch((error) => {
        console.error("updatePaneLayout failed", error);
      });
    };

    const schedule = () => {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        push();
      }, 16);
    };

    const capture = () => {
      latestRect = host.getBoundingClientRect();
      schedule();
    };

    capture();

    const observer = new ResizeObserver(capture);
    observer.observe(host);
    window.addEventListener("resize", capture);

    // A display change bumps scale_factor: re-push layout so the Rust side
    // rebuilds the atlas and resizes the surface at the new DPR.
    let scaleListener: (() => void) | null = null;
    void listen<{ scale_factor: number }>("tauri://scale-change", capture).then(
      (fn) => {
        scaleListener = fn;
      },
    );

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", capture);
      scaleListener?.();
      if (pending !== null) window.clearTimeout(pending);
    };
  }, [sessionId]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        background: "transparent",
      }}
    >
      <div
        ref={paneHostRef}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      />
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
