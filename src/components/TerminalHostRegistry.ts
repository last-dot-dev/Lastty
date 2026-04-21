import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  getFontConfig,
  getTerminalFrame,
  submitStressFrontendSample,
  terminalInput,
  terminalScroll,
  terminalResize,
  type TerminalFrame,
  type TerminalFrameEvent,
} from "../lib/ipc";
import { prepareXtermFrameWrite, type XtermFrameState } from "../app/xtermFrame";
import { writeSelectionToClipboard } from "../app/xtermSelection";
import type { PersistedTerminalSnapshot } from "../app/sessionRestore";
import { xtermThemeFor } from "./terminalTheme";

type EffectiveTheme = "light" | "dark";

// `options.theme` swap doesn't invalidate the WebGL renderer's glyph texture
// atlas, so cells rendered under the old theme keep their baked-in fg/bg.
// Clear the atlas (if the build supports it) and force a full repaint.
function repaintAfterThemeChange(terminal: Terminal): void {
  try {
    (terminal as Terminal & { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
  } catch {
    // best-effort
  }
  try {
    terminal.refresh(0, terminal.rows - 1);
  } catch {
    // terminal may not yet be attached
  }
}

function focusTerminalIfActive(entry: Entry): void {
  try {
    if (entry.focusedRef.current && !entry.blockedRef.current) {
      entry.terminal.focus();
    } else {
      entry.terminal.blur();
    }
  } catch {
    // terminal may not yet be attached
  }
}

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
  latestFrame: TerminalFrame | null;
  resizeObserver: ResizeObserver;
  unlistenFrame: (() => void) | null;
  removeCopyListener: (() => void) | null;
  removeWheelListener: (() => void) | null;
  wheelAccumDy: number;
  pendingScrollbackClear: boolean;
  snapshotTimer: number | null;
  status: string;
  statusListeners: Set<StatusListener>;
  currentSlot: HTMLElement | null;
  blockedRef: { current: boolean };
  focusedRef: { current: boolean };
  snapshotCallbackRef: { current: ((s: PersistedTerminalSnapshot) => void) | undefined };
  restoredSnapshotRef: { current: PersistedTerminalSnapshot | null | undefined };
  lastSentCols: number;
  lastSentRows: number;
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

const ERASE_SAVED_LINES = new Uint8Array([0x1b, 0x5b, 0x33, 0x4a]);

const PASTE_CHUNK_CHARS = 16 * 1024;

// Large pastes (xterm wraps bracketed pastes in a single onData call) can stall
// the renderer while TextEncoder + IPC serialize the whole blob. Split into
// 16K-char chunks with a macrotask yield between sends so paint lands in
// between.
function sendTerminalInput(sessionId: string, data: string) {
  if (data.length <= PASTE_CHUNK_CHARS) {
    const bytes = Array.from(new TextEncoder().encode(data));
    terminalInput(sessionId, bytes).catch((error) => {
      console.error("terminal input failed", error);
    });
    return;
  }

  let offset = 0;
  const sendNext = () => {
    if (offset >= data.length) return;
    let end = Math.min(offset + PASTE_CHUNK_CHARS, data.length);
    if (end < data.length) {
      const code = data.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    const chunk = data.slice(offset, end);
    offset = end;
    const bytes = Array.from(new TextEncoder().encode(chunk));
    terminalInput(sessionId, bytes)
      .then(() => {
        if (offset < data.length) setTimeout(sendNext, 0);
      })
      .catch((error) => {
        console.error("terminal input failed", error);
      });
  };
  sendNext();
}

// Consume query-response sequences that apps sometimes echo back into the
// output stream (CPR replies, focus in/out, DECRQSS replies). Without this the
// parser tries to interpret them and can render stray cells or mis-advance the
// cursor. `parser` is a proposed API, so guard against its absence.
function suppressQueryResponses(terminal: Terminal) {
  const parser = (terminal as unknown as { parser?: { registerCsiHandler?: Function; registerDcsHandler?: Function } }).parser;
  if (!parser?.registerCsiHandler) return;
  parser.registerCsiHandler({ final: "R" }, () => true);
  parser.registerCsiHandler(
    { final: "I" },
    (params: (number | number[])[]) => params.length === 0,
  );
  parser.registerCsiHandler({ final: "O" }, () => true);
  parser.registerDcsHandler?.({ intermediates: "$", final: "r" }, () => true);
}

function syncTerminalViewport(entry: Entry): Promise<void> {
  try {
    entry.fit.fit();
  } catch {
    return Promise.resolve();
  }

  const { cols, rows } = entry.terminal;
  if (cols === entry.lastSentCols && rows === entry.lastSentRows) {
    return Promise.resolve();
  }
  entry.lastSentCols = cols;
  entry.lastSentRows = rows;

  return terminalResize(entry.sessionId, cols, rows).catch((error) => {
    console.error("terminal resize failed", error);
  });
}

function cellHeightPx(entry: Entry): number {
  const fontSize = Number(entry.terminal.options.fontSize ?? 14);
  const lineHeight = Number(entry.terminal.options.lineHeight ?? 1);
  return fontSize * lineHeight;
}

function bindWheelScroll(entry: Entry) {
  const handleWheel = (event: WheelEvent) => {
    const frame = entry.latestFrame;
    if (frame?.alternate_screen) return;

    const visibleRows = Math.max(entry.terminal.rows, 1);
    const totalLines = frame?.total_lines ?? 0;
    const displayOffset = frame?.display_offset ?? 0;

    const dy = event.deltaY;
    const scrollingUp = dy < 0;
    const scrollingDown = dy > 0;

    const canScrollUpInRust = scrollingUp && totalLines - displayOffset > visibleRows;
    const canScrollDownInRust = scrollingDown && displayOffset > 0;
    if (!canScrollUpInRust && !canScrollDownInRust) {
      return;
    }

    const cellPx = cellHeightPx(entry);
    if (!(cellPx > 0)) return;

    event.preventDefault();
    event.stopPropagation();

    const pixelDelta =
      event.deltaMode === 1
        ? dy * cellPx
        : event.deltaMode === 2
          ? dy * cellPx * visibleRows
          : dy;

    entry.wheelAccumDy += pixelDelta;
    const lines = Math.trunc(entry.wheelAccumDy / cellPx);
    if (lines === 0) return;
    entry.wheelAccumDy -= lines * cellPx;

    terminalScroll(entry.sessionId, -lines).catch((error) => {
      console.error("terminal scroll failed", error);
    });
  };

  entry.host.addEventListener("wheel", handleWheel, { capture: true, passive: false });
  entry.removeWheelListener = () =>
    entry.host.removeEventListener("wheel", handleWheel, { capture: true });
}

async function initEntry(entry: Entry, initialProps: SessionHostProps) {
  const { host, terminal, sessionId } = entry;

  try {
    const font = await getFontConfig();
    terminal.options.fontFamily = `${font.family}, NFFallback, Monaco, monospace`;
    terminal.options.fontSize = font.size_px;
    terminal.options.lineHeight = font.line_height;
  } catch {
    // keep constructor defaults if the host doesn't expose font config
  }

  entry.fit = new FitAddon();
  terminal.loadAddon(entry.fit);
  entry.serialize = new SerializeAddon();
  terminal.loadAddon(entry.serialize);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  suppressQueryResponses(terminal);

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

  console.log(`[resume] initEntry terminal.open ${sessionId}`);
  terminal.open(host);
  focusTerminalIfActive(entry);
  bindWheelScroll(entry);
  entry.resizeObserver = new ResizeObserver(() => {
    if (entry.disposed) return;
    entry.pendingScrollbackClear = true;
    void syncTerminalViewport(entry);
  });
  entry.resizeObserver.observe(host);
  await syncTerminalViewport(entry);

  const handleCopy = (event: ClipboardEvent) => {
    if (!terminal.hasSelection()) return;
    writeSelectionToClipboard(terminal, event);
  };
  host.addEventListener("copy", handleCopy);
  entry.removeCopyListener = () => host.removeEventListener("copy", handleCopy);

  const writeFrame = (frame: TerminalFrame) => {
    entry.latestFrame = frame;
    const prepared = prepareXtermFrameWrite(frame, entry.frameState);
    entry.frameState = prepared.state;
    let bytes = prepared.bytes;
    if (entry.pendingScrollbackClear) {
      entry.pendingScrollbackClear = false;
      const merged = new Uint8Array(ERASE_SAVED_LINES.length + bytes.length);
      merged.set(ERASE_SAVED_LINES, 0);
      merged.set(bytes, ERASE_SAVED_LINES.length);
      bytes = merged;
    }
    if (__LASTTY_BENCH__) {
      const writeStart = performance.now();
      terminal.write(bytes, () => {
        void submitStressFrontendSample(
          sessionId,
          performance.now() - writeStart,
        ).catch(() => {});
      });
    } else {
      terminal.write(bytes);
    }
  };

  terminal.onData((data) => {
    if (entry.blockedRef.current) return;
    sendTerminalInput(sessionId, data);
  });

  const unlistenFrame = await listen<TerminalFrameEvent>("term:frame", (event) => {
    if (entry.disposed || event.payload.session_id !== sessionId) return;
    writeFrame(event.payload.frame);
    scheduleSnapshot();
  });
  entry.unlistenFrame = unlistenFrame;
  console.log(`[resume] initEntry listener registered ${sessionId}`);

  if (persistedSnapshot?.serializedBuffer) {
    setStatus(entry, `session ${sessionId} (restored)`);
    scheduleSnapshot();
  } else {
    console.log(`[resume] initEntry fetching initial frame ${sessionId}`);
    try {
      const initialFrame = await getTerminalFrame(sessionId);
      if (entry.frameState === null) {
        writeFrame(initialFrame);
      }
      setStatus(entry, `session ${sessionId}`);
      scheduleSnapshot();
      console.log(`[resume] initEntry initial frame applied ${sessionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[resume] initEntry initial frame failed ${sessionId}`, message);
      setStatus(entry, `session ${sessionId} (live)`);
      scheduleSnapshot();
    }
  }
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
    cursorInactiveStyle: "outline",
    fontFamily: "Menlo, NFFallback, Monaco, monospace",
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
    latestFrame: null,
    resizeObserver: null as unknown as ResizeObserver,
    unlistenFrame: null,
    removeCopyListener: null,
    removeWheelListener: null,
    wheelAccumDy: 0,
    pendingScrollbackClear: false,
    snapshotTimer: null,
    status: "initializing",
    statusListeners: new Set(),
    currentSlot: null,
    blockedRef: { current: props.blocked },
    focusedRef: { current: props.focused },
    snapshotCallbackRef: { current: props.onSnapshotChange },
    restoredSnapshotRef: { current: props.restoredSnapshot },
    lastSentCols: 0,
    lastSentRows: 0,
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
  const existing = entries.has(sessionId);
  console.log(`[resume] attach ${sessionId} existing=${existing}`);
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
    repaintAfterThemeChange(entry.terminal);
  }

  focusTerminalIfActive(entry);
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
    repaintAfterThemeChange(entry.terminal);
  }
  focusTerminalIfActive(entry);
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
  entry.removeWheelListener?.();
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
