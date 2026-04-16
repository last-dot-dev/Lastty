import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  getPrimarySessionId,
  getTerminalFrame,
  terminalInput,
  terminalResize,
  type TerminalFrameEvent,
} from "./lib/ipc";

export default function XtermTerminal() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("initializing");

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let unlisten: (() => void) | null = null;

    async function mount() {
      const sessionId = await getPrimarySessionId();
      if (!sessionId) {
        setStatus("no session");
        return;
      }
      if (!hostRef.current || disposed) return;

      terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: "Menlo, Monaco, monospace",
        fontSize: 14,
        lineHeight: 1.2,
        scrollback: 0,
        theme: {
          background: "#0f1014",
          foreground: "#dcdcdc",
          cursor: "#dcdcdc",
        },
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      terminal.open(hostRef.current);
      fitAddon.fit();

      await terminalResize(sessionId, terminal.cols, terminal.rows);
      const initialFrame = await getTerminalFrame(sessionId);
      terminal.write(new Uint8Array(initialFrame.ansi));
      setStatus(`session ${sessionId}`);

      terminal.onData((data) => {
        const bytes = Array.from(new TextEncoder().encode(data));
        terminalInput(sessionId, bytes).catch((error) => {
          console.error("terminal input failed", error);
        });
      });

      resizeObserver = new ResizeObserver(() => {
        if (!terminal || !fitAddon) return;
        fitAddon.fit();
        terminalResize(sessionId, terminal.cols, terminal.rows).catch((error) => {
          console.error("terminal resize failed", error);
        });
      });
      resizeObserver.observe(hostRef.current);

      const eventUnlisten = await listen<TerminalFrameEvent>("term:frame", (event) => {
        if (!terminal || event.payload.session_id !== sessionId) return;
        terminal.write(new Uint8Array(event.payload.frame.ansi));
      });
      unlisten = eventUnlisten;
    }

    mount().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`failed: ${message}`);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      unlisten?.();
      webglAddon?.dispose();
      terminal?.dispose();
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        gridTemplateRows: "auto 1fr",
        background: "#0f1014",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          color: "#8ac",
          fontFamily: "monospace",
          fontSize: 12,
          borderBottom: "1px solid #20242f",
        }}
      >
        {status}
      </div>
      <div ref={hostRef} />
    </div>
  );
}
