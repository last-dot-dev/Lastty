import { memo, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import type { PersistedTerminalSnapshot } from "../app/sessionRestore";
import { useEffectiveTheme } from "../hooks/useThemeOverride";
import {
  attachTerminalHost,
  detachTerminalHost,
  subscribeTerminalHostStatus,
  updateTerminalHostProps,
} from "./TerminalHostRegistry";

interface TerminalViewportProps {
  blocked?: boolean;
  focused: boolean;
  onActivate: () => void;
  onSnapshotChange?: (snapshot: PersistedTerminalSnapshot) => void;
  restoredSnapshot?: PersistedTerminalSnapshot | null;
  sessionId: string;
}

function TerminalViewportInner({
  blocked = false,
  focused,
  onActivate,
  onSnapshotChange,
  restoredSnapshot = null,
  sessionId,
}: TerminalViewportProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("initializing");
  const effectiveTheme = useEffectiveTheme();

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    attachTerminalHost(sessionId, slot, {
      blocked,
      focused,
      onSnapshotChange,
      restoredSnapshot,
      theme: effectiveTheme,
    });
    const unsubscribe = subscribeTerminalHostStatus(sessionId, setStatus);
    return () => {
      unsubscribe();
      detachTerminalHost(sessionId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    updateTerminalHostProps(sessionId, {
      blocked,
      focused,
      onSnapshotChange,
      restoredSnapshot,
      theme: effectiveTheme,
    });
  }, [blocked, focused, onSnapshotChange, restoredSnapshot, effectiveTheme, sessionId]);

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
      <div
        data-testid="terminal-slot"
        ref={slotRef}
        className="agent-terminal-slot"
        style={{ minHeight: 0, position: "relative" }}
      />
    </div>
  );
}

// Layout re-renders (splitter drags, sibling updates) fire ancestor renders with
// fresh inline callback identities. The registry stashes the latest callbacks in
// refs via updateTerminalHostProps, and parent state setters use updater form, so
// skipping re-renders driven solely by callback identity is safe.
const TerminalViewport = memo(TerminalViewportInner, (prev, next) => {
  return (
    prev.sessionId === next.sessionId &&
    prev.blocked === next.blocked &&
    prev.focused === next.focused &&
    prev.restoredSnapshot === next.restoredSnapshot
  );
});

export default TerminalViewport;
