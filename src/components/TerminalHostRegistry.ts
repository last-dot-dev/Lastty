import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";

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
import { xtermThemeFor } from "./terminalTheme";

type EffectiveTheme = "light" | "dark";

export interface SessionHostProps {
  blocked: boolean;
  focused: boolean;
  theme: EffectiveTheme;
  onSnapshotChange?: (snapshot: PersistedTerminalSnapshot) => void;
  restoredSnapshot?: PersistedTerminalSnapshot | null;
}

type StatusListener = (status: string) => void;

interface Entry {
  sessionId: string;
  host: HTMLDivElement;
  terminal: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  webgl: WebglAddon | null;
  frameState: XtermFrameState | null;
  resizeObserver: ResizeObserver;
  unlistenFrame: (() => void) | null;
  removeCopyListener: (() => void) | null;
  snapshotTimer: number | null;
  status: string;
  statusListeners: Set<StatusListener>;
  currentSlot: HTMLElement | null;
  blockedRef: { current: boolean };
  focusedRef: { current: boolean };
  snapshotCallbackRef: { current: ((s: PersistedTerminalSnapshot) => void) | undefined };
  restoredSnapshotRef: { current: PersistedTerminalSnapshot | null | undefined };
  disposed: boolean;
}

const entries = new Map<string, Entry>();
let pool: HTMLDivElement | null = null;

function ensurePool(): HTMLDivElement {
  if (pool && pool.isConnected) return pool;
  pool = document.createElement("div");
  pool.setAttribute("data-testid", "terminal-host-pool");
  pool.style.position = "absolute";
  pool.style.width = "0";
  pool.style.height = "0";
  pool.style.overflow = "hidden";
  pool.style.visibility = "hidden";
  pool.style.pointerEvents = "none";
  pool.style.left = "-99999px";
  pool.style.top = "-99999px";
  document.body.appendChild(pool);
  return pool;
}

function setStatus(entry: Entry, status: string) {
  if (entry.status === status) return;
  entry.status = status;
  for (const listener of entry.statusListeners) {
    listener(status);
  }
}

async function initEntry(entry: Entry, initialProps: SessionHostProps) {
  const { host, terminal, sessionId } = entry;

  try {
    const font = await getFontConfig();
    terminal.options.fontFamily = `${font.family}, Monaco, monospace`;
    terminal.options.fontSize = font.size_px;
    terminal.options.lineHeight = font.line_height;
  } catch {
    // keep constructor defaults if the host doesn't expose font config
  }

  entry.fit = new FitAddon();
  terminal.loadAddon(entry.fit);
  entry.serialize = new SerializeAddon();
  terminal.loadAddon(entry.serialize);

  const scheduleSnapshot = () => {
    if (entry.snapshotTimer !== null) {
      window.clearTimeout(entry.snapshotTimer);
    }
    entry.snapshotTimer = window.setTimeout(() => {
      entry.snapshotTimer = null;
      const cb = entry.snapshotCallbackRef.current;
      if (!cb || !entry.serialize) return;
      cb({
        capturedAtMs: Date.now(),
        cols: terminal.cols,
        rows: terminal.rows,
        serializedBuffer: entry.serialize.serialize({ scrollback: 10_000 }),
      });
    }, 150);
  };

  const persistedSnapshot = entry.restoredSnapshotRef.current ?? initialProps.restoredSnapshot;
  if (persistedSnapshot?.serializedBuffer) {
    terminal.write(persistedSnapshot.serializedBuffer);
  }

  try {
    entry.webgl = new WebglAddon();
    entry.webgl.onContextLoss(() => {
      setStatus(entry, `session ${sessionId} (canvas fallback)`);
      entry.webgl?.dispose();
      entry.webgl = null;
    });
    terminal.loadAddon(entry.webgl);
  } catch {
    entry.webgl = null;
  }

  terminal.open(host);
  entry.fit.fit();

  const handleCopy = (event: ClipboardEvent) => {
    if (!terminal.hasSelection()) return;
    writeSelectionToClipboard(terminal, event);
  };
  host.addEventListener("copy", handleCopy);
  entry.removeCopyListener = () => host.removeEventListener("copy", handleCopy);

  const writeFrame = (frame: TerminalFrame) => {
    const prepared = prepareXtermFrameWrite(frame, entry.frameState);
    entry.frameState = prepared.state;
    terminal.write(prepared.bytes);
  };

  await terminalResize(sessionId, terminal.cols, terminal.rows);

  if (persistedSnapshot?.serializedBuffer) {
    setStatus(entry, `session ${sessionId} (restored)`);
    scheduleSnapshot();
  } else {
    try {
      const initialFrame = await getTerminalFrame(sessionId);
      writeFrame(initialFrame);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(entry, `failed: ${message}`);
      return;
    }
    setStatus(entry, `session ${sessionId}`);
    scheduleSnapshot();
  }

  terminal.onData((data) => {
    if (entry.blockedRef.current) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    terminalInput(sessionId, bytes).catch((error) => {
      console.error("terminal input failed", error);
    });
  });

  entry.resizeObserver = new ResizeObserver(() => {
    if (entry.disposed) return;
    entry.fit.fit();
    terminalResize(sessionId, terminal.cols, terminal.rows).catch((error) => {
      console.error("terminal resize failed", error);
    });
  });
  entry.resizeObserver.observe(host);

  const unlistenFrame = await listen<TerminalFrameEvent>("term:frame", (event) => {
    if (entry.disposed || event.payload.session_id !== sessionId) return;
    writeFrame(event.payload.frame);
    scheduleSnapshot();
  });
  entry.unlistenFrame = unlistenFrame;
}

function createEntry(sessionId: string, props: SessionHostProps): Entry {
  const host = document.createElement("div");
  host.setAttribute("data-testid", "terminal-host");
  host.className = "agent-terminal-host";
  host.style.minHeight = "0";
  host.style.height = "100%";
  host.style.width = "100%";
  ensurePool().appendChild(host);

  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: "Menlo, Monaco, monospace",
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 10_000,
    theme: xtermThemeFor(props.theme),
  });

  const entry: Entry = {
    sessionId,
    host,
    terminal,
    fit: null as unknown as FitAddon,
    serialize: null as unknown as SerializeAddon,
    webgl: null,
    frameState: null,
    resizeObserver: null as unknown as ResizeObserver,
    unlistenFrame: null,
    removeCopyListener: null,
    snapshotTimer: null,
    status: "initializing",
    statusListeners: new Set(),
    currentSlot: null,
    blockedRef: { current: props.blocked },
    focusedRef: { current: props.focused },
    snapshotCallbackRef: { current: props.onSnapshotChange },
    restoredSnapshotRef: { current: props.restoredSnapshot },
    disposed: false,
  };

  entries.set(sessionId, entry);
  void initEntry(entry, props).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(entry, `failed: ${message}`);
  });
  return entry;
}

export function attachTerminalHost(
  sessionId: string,
  slot: HTMLElement,
  props: SessionHostProps,
): void {
  const entry = entries.get(sessionId) ?? createEntry(sessionId, props);
  entry.blockedRef.current = props.blocked;
  entry.focusedRef.current = props.focused;
  entry.snapshotCallbackRef.current = props.onSnapshotChange;
  entry.restoredSnapshotRef.current = props.restoredSnapshot;

  if (entry.currentSlot !== slot) {
    slot.appendChild(entry.host);
    entry.currentSlot = slot;
    if (entry.fit) {
      try {
        entry.fit.fit();
      } catch {
        // ignore pre-init fit errors
      }
    }
  }

  if (entry.terminal.options && props.theme) {
    entry.terminal.options.theme = xtermThemeFor(props.theme);
  }

  if (props.focused && !props.blocked) {
    try {
      entry.terminal.focus();
    } catch {
      // terminal may not yet be attached
    }
  }
}

export function detachTerminalHost(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  if (entry.currentSlot && entry.host.parentElement === entry.currentSlot) {
    ensurePool().appendChild(entry.host);
  }
  entry.currentSlot = null;
}

export function updateTerminalHostProps(
  sessionId: string,
  props: Partial<SessionHostProps>,
): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  if (props.blocked !== undefined) entry.blockedRef.current = props.blocked;
  if (props.focused !== undefined) entry.focusedRef.current = props.focused;
  if (props.onSnapshotChange !== undefined) {
    entry.snapshotCallbackRef.current = props.onSnapshotChange;
  }
  if (props.restoredSnapshot !== undefined) {
    entry.restoredSnapshotRef.current = props.restoredSnapshot;
  }
  if (props.theme && entry.terminal.options) {
    entry.terminal.options.theme = xtermThemeFor(props.theme);
  }
  if (props.focused && !entry.blockedRef.current) {
    try {
      entry.terminal.focus();
    } catch {
      // ignore
    }
  }
}

export function subscribeTerminalHostStatus(
  sessionId: string,
  listener: StatusListener,
): () => void {
  const entry = entries.get(sessionId);
  if (!entry) {
    listener("initializing");
    return () => {};
  }
  listener(entry.status);
  entry.statusListeners.add(listener);
  return () => {
    entry.statusListeners.delete(listener);
  };
}

export function releaseTerminalHost(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.disposed = true;
  entry.resizeObserver?.disconnect();
  entry.unlistenFrame?.();
  entry.removeCopyListener?.();
  if (entry.snapshotTimer !== null) {
    window.clearTimeout(entry.snapshotTimer);
  }
  const snapshotCb = entry.snapshotCallbackRef.current;
  if (snapshotCb && entry.serialize) {
    snapshotCb({
      capturedAtMs: Date.now(),
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      serializedBuffer: entry.serialize.serialize({ scrollback: 10_000 }),
    });
  }
  entry.webgl?.dispose();
  entry.terminal.dispose();
  if (entry.host.parentElement) {
    entry.host.parentElement.removeChild(entry.host);
  }
  entry.statusListeners.clear();
  entries.delete(sessionId);
}

export function resetTerminalHostRegistryForTests(): void {
  for (const sessionId of Array.from(entries.keys())) {
    releaseTerminalHost(sessionId);
  }
  if (pool && pool.parentElement) {
    pool.parentElement.removeChild(pool);
  }
  pool = null;
}
