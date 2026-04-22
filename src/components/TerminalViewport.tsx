import { memo, useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import type { PersistedTerminalSnapshot } from "../app/sessionRestore";
import { useEffectiveTheme } from "../hooks/useThemeOverride";
import { terminalInput } from "../lib/ipc";
import {
  attachTerminalHost,
  detachTerminalHost,
  subscribeTerminalHostStatus,
  updateTerminalHostProps,
} from "./TerminalHostRegistry";

function ClaudeLogo() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="#D97757"
      aria-hidden="true"
    >
      <path d="M12 2 Q13 10 22 12 Q13 14 12 22 Q11 14 2 12 Q11 10 12 2 Z" />
    </svg>
  );
}

function CodexLogo() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <g transform="translate(12 12)">
        <ellipse rx="4" ry="9" />
        <ellipse rx="4" ry="9" transform="rotate(60)" />
        <ellipse rx="4" ry="9" transform="rotate(120)" />
      </g>
    </svg>
  );
}

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
    console.log("[resume] viewport mount", sessionId);
    attachTerminalHost(sessionId, slot, {
      blocked,
      focused,
      onSnapshotChange,
      restoredSnapshot,
      theme: effectiveTheme,
    });
    const unsubscribe = subscribeTerminalHostStatus(sessionId, setStatus);
    return () => {
      console.log("[resume] viewport unmount", sessionId);
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

  const [launched, setLaunched] = useState(false);

  // No install fallback: we won't invoke a package manager on the user's behalf —
  // they may not have npm, and forcing a global install via a package manager they
  // didn't choose is not our call to make.
  const launchCli = useCallback(
    (command: string) => {
      const bytes = Array.from(new TextEncoder().encode(`${command}\n`));
      void terminalInput(sessionId, bytes);
      setLaunched(true);
    },
    [sessionId],
  );

  const hasSelection = launched || restoredSnapshot !== null;

  return (
    <div
      style={{
        minHeight: 0,
        height: "100%",
        display: "grid",
        gridTemplateRows: hasSelection ? "1fr" : "auto 1fr",
        background: "var(--color-background-primary)",
      }}
      onMouseDown={onActivate}
    >
      {!hasSelection && (
        <div className="terminal-launch-row">
          <div
            data-testid="terminal-status"
            className="terminal-launch-status"
          >
            {status}
          </div>
          <div className="terminal-launch-actions">
            <button
              type="button"
              className="terminal-launch-btn"
              title="Start Claude Code (`claude --dangerously-skip-permissions`)"
              aria-label="Start Claude Code in this terminal"
              onClick={() => launchCli("claude --dangerously-skip-permissions")}
            >
              <ClaudeLogo />
            </button>
            <button
              type="button"
              className="terminal-launch-btn"
              title="Start Codex CLI (`codex --dangerously-bypass-approvals-and-sandbox`)"
              aria-label="Start Codex CLI in this terminal"
              onClick={() =>
                launchCli("codex --dangerously-bypass-approvals-and-sandbox")
              }
            >
              <CodexLogo />
            </button>
          </div>
        </div>
      )}
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
