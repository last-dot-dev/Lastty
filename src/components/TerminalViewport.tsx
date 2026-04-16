import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import {
  getFontConfig,
  getTerminalFrame,
  terminalInput,
  terminalResize,
  type TerminalFrame,
  type TerminalFrameEvent,
} from "../lib/ipc";
import { prepareXtermFrameWrite, type XtermFrameState } from "../app/xtermFrame";
import { writeSelectionToClipboard } from "../app/xtermSelection";
import type { PersistedTerminalSnapshot } from "../app/sessionRestore";
import { useEffectiveTheme } from "../hooks/useThemeOverride";
import { xtermThemeFor } from "./terminalTheme";

interface TerminalViewportProps {
  blocked?: boolean;
  focused: boolean;
  onActivate: () => void;
  onSnapshotChange?: (snapshot: PersistedTerminalSnapshot) => void;
  restoredSnapshot?: PersistedTerminalSnapshot | null;
  sessionId: string;
  /// "wgpu" means Rust renders the terminal grid into a native subview that
  /// overlays this component's host div. In that mode we skip xterm entirely
  /// and just measure our host rect so the workspace can push it to Rust.
  rendererMode?: string | null;
  onRectChange?: (sessionId: string, rect: DOMRect | null) => void;
}

export default function TerminalViewport({
  blocked = false,
  focused,
  onActivate,
  onSnapshotChange,
  restoredSnapshot = null,
  sessionId,
  rendererMode,
  onRectChange,
}: TerminalViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const frameStateRef = useRef<XtermFrameState | null>(null);
  const blockedRef = useRef(blocked);
  const onSnapshotChangeRef = useRef(onSnapshotChange);
  const restoredSnapshotRef = useRef(restoredSnapshot);
  const onRectChangeRef = useRef(onRectChange);
  const [status, setStatus] = useState("initializing");
  const effectiveTheme = useEffectiveTheme();
  const themeRef = useRef(effectiveTheme);
  themeRef.current = effectiveTheme;
  const wgpuMode = rendererMode === "wgpu";

  useEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);

  useEffect(() => {
    onSnapshotChangeRef.current = onSnapshotChange;
  }, [onSnapshotChange]);

  useEffect(() => {
    restoredSnapshotRef.current = restoredSnapshot;
  }, [restoredSnapshot]);

  useEffect(() => {
    onRectChangeRef.current = onRectChange;
  }, [onRectChange]);

  useEffect(() => {
    if (!wgpuMode) return;
    const host = hostRef.current;
    if (!host) return;

    const push = () => {
      onRectChangeRef.current?.(sessionId, host.getBoundingClientRect());
    };
    push();

    const observer = new ResizeObserver(push);
    observer.observe(host);
    window.addEventListener("resize", push);
    setStatus(`session ${sessionId}`);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", push);
      onRectChangeRef.current?.(sessionId, null);
    };
  }, [sessionId, wgpuMode]);

  useEffect(() => {
    if (wgpuMode) return;
    let disposed = false;
    let fitAddon: FitAddon | null = null;
    let serializeAddon: SerializeAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let unlisten: (() => void) | null = null;
    let removeCopyListener: (() => void) | null = null;
    let snapshotTimer: number | null = null;

    async function mount() {
      if (!hostRef.current) return;
      const hostElement = hostRef.current;

      const font = await getFontConfig();
      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: `${font.family}, Monaco, monospace`,
        fontSize: font.size_px,
        lineHeight: font.line_height,
        scrollback: 10_000,
        theme: xtermThemeFor(themeRef.current),
      });
      terminalRef.current = terminal;
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      serializeAddon = new SerializeAddon();
      terminal.loadAddon(serializeAddon);

      const emitSnapshot = () => {
        const snapshotListener = onSnapshotChangeRef.current;
        if (!serializeAddon || !snapshotListener || !terminalRef.current) {
          return;
        }
        snapshotListener({
          capturedAtMs: Date.now(),
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
          serializedBuffer: serializeAddon.serialize({ scrollback: 10_000 }),
        });
      };

      const scheduleSnapshot = () => {
        if (snapshotTimer !== null) {
          window.clearTimeout(snapshotTimer);
        }
        snapshotTimer = window.setTimeout(() => {
          snapshotTimer = null;
          emitSnapshot();
        }, 150);
      };

      const persistedSnapshot = restoredSnapshotRef.current;
      if (persistedSnapshot?.serializedBuffer) {
        terminal.write(persistedSnapshot.serializedBuffer);
      }

      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        setStatus(`session ${sessionId} (canvas fallback)`);
        webglAddon?.dispose();
        webglAddon = null;
      });
      terminal.loadAddon(webglAddon);
      terminal.open(hostElement);
      fitAddon.fit();

      const handleCopy = (event: ClipboardEvent) => {
        const currentTerminal = terminalRef.current;
        if (!currentTerminal?.hasSelection()) {
          return;
        }

        writeSelectionToClipboard(currentTerminal, event);
      };
      hostElement.addEventListener("copy", handleCopy);
      removeCopyListener = () => hostElement.removeEventListener("copy", handleCopy);

      const writeFrame = (frame: TerminalFrame) => {
        if (!terminalRef.current) return;
        const prepared = prepareXtermFrameWrite(frame, frameStateRef.current);
        frameStateRef.current = prepared.state;
        terminalRef.current.write(prepared.bytes);
      };

      await terminalResize(sessionId, terminal.cols, terminal.rows);
      if (persistedSnapshot?.serializedBuffer) {
        setStatus(`session ${sessionId} (restored)`);
        scheduleSnapshot();
      } else {
        const initialFrame = await getTerminalFrame(sessionId);
        writeFrame(initialFrame);
        setStatus(`session ${sessionId}`);
        scheduleSnapshot();
      }

      terminal.onData((data) => {
        if (blockedRef.current) {
          return;
        }
        const bytes = Array.from(new TextEncoder().encode(data));
        terminalInput(sessionId, bytes).catch((error) => {
          console.error("terminal input failed", error);
        });
      });

      resizeObserver = new ResizeObserver(() => {
        if (!terminalRef.current || !fitAddon) return;
        fitAddon.fit();
        terminalResize(sessionId, terminalRef.current.cols, terminalRef.current.rows).catch(
          (error) => {
            console.error("terminal resize failed", error);
          },
        );
      });
      resizeObserver.observe(hostElement);

      const eventUnlisten = await listen<TerminalFrameEvent>("term:frame", (event) => {
        if (!terminalRef.current || event.payload.session_id !== sessionId) return;
        writeFrame(event.payload.frame);
        scheduleSnapshot();
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
      removeCopyListener?.();
      if (snapshotTimer !== null) {
        window.clearTimeout(snapshotTimer);
      }
      const snapshotListener = onSnapshotChangeRef.current;
      if (serializeAddon && snapshotListener && terminalRef.current) {
        snapshotListener({
          capturedAtMs: Date.now(),
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
          serializedBuffer: serializeAddon.serialize({ scrollback: 10_000 }),
        });
      }
      webglAddon?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      frameStateRef.current = null;
      if (disposed) {
        setStatus("disposed");
      }
    };
  }, [sessionId, wgpuMode]);

  useEffect(() => {
    if (focused && !blocked) {
      terminalRef.current?.focus();
    }
  }, [blocked, focused]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal?.options) return;
    terminal.options.theme = xtermThemeFor(effectiveTheme);
  }, [effectiveTheme]);

  return (
    <div
      style={{
        minHeight: 0,
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        background: "var(--color-background-primary)",
      }}
      onMouseDown={onActivate}
    >
      <div
        data-testid="terminal-status"
        style={{
          padding: "4px 10px",
          color: "var(--color-text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          borderBottom: "0.5px solid var(--color-border-tertiary)",
        }}
      >
        {status}
      </div>
      <div data-testid="terminal-host" ref={hostRef} style={{ minHeight: 0 }} />
    </div>
  );
}
