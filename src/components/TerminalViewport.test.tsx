// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SelectionBuffer } from "../app/xtermSelection";
import type { TerminalFrameEvent } from "../lib/ipc";

const harness = vi.hoisted(() => {
  class FakeFitAddon {
    fit = vi.fn();
  }

  class FakeWebglAddon {
    contextLossHandler: (() => void) | null = null;
    disposed = false;

    onContextLoss(handler: () => void) {
      this.contextLossHandler = handler;
    }

    dispose() {
      this.disposed = true;
    }
  }

  class FakeSerializeAddon {
    serialize = vi.fn(() => "SERIALIZED");
  }

  class FakeTerminal {
    static instances: FakeTerminal[] = [];

    cols = 80;
    rows = 24;
    writes: Array<Uint8Array | string> = [];
    addons: unknown[] = [];
    selectionPosition:
      | {
          start: { x: number; y: number };
          end: { x: number; y: number };
        }
      | undefined;
    buffer: { active: SelectionBuffer } = { active: emptySelectionBuffer() };
    focused = false;
    disposed = false;
    host: Element | null = null;
    dataHandlers: Array<(data: string) => void> = [];

    constructor(_options: unknown) {
      FakeTerminal.instances.push(this);
    }

    loadAddon(addon: unknown) {
      this.addons.push(addon);
    }

    open(host: Element) {
      this.host = host;
    }

    write(data: Uint8Array | string) {
      this.writes.push(data);
    }

    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
      return {
        dispose() {},
      };
    }

    focus() {
      this.focused = true;
    }

    hasSelection() {
      return Boolean(this.selectionPosition);
    }

    getSelectionPosition() {
      return this.selectionPosition;
    }

    dispose() {
      this.disposed = true;
    }
  }

  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const terminalResizeMock = vi.fn(async () => {});
  const terminalInputMock = vi.fn(async () => {});
  const getTerminalFrameMock = vi.fn(async () => makeFrame(false, ""));
  const listenMock = vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = listeners.get(eventName) ?? new Set();
    handlers.add(handler);
    listeners.set(eventName, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        listeners.delete(eventName);
      }
    };
  });

  function emit(eventName: string, payload: unknown) {
    for (const handler of listeners.get(eventName) ?? []) {
      handler({ payload });
    }
  }

  function reset() {
    FakeTerminal.instances.length = 0;
    listeners.clear();
    terminalResizeMock.mockReset();
    terminalResizeMock.mockResolvedValue(undefined);
    terminalInputMock.mockReset();
    terminalInputMock.mockResolvedValue(undefined);
    getTerminalFrameMock.mockReset();
    getTerminalFrameMock.mockResolvedValue(makeFrame(false, ""));
    listenMock.mockClear();
  }

  return {
    FakeFitAddon,
    FakeSerializeAddon,
    FakeTerminal,
    FakeWebglAddon,
    emit,
    getTerminalFrameMock,
    listenMock,
    reset,
    terminalInputMock,
    terminalResizeMock,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: harness.listenMock,
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    getTerminalFrame: harness.getTerminalFrameMock,
    terminalInput: harness.terminalInputMock,
    terminalResize: harness.terminalResizeMock,
  };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: harness.FakeFitAddon,
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: harness.FakeWebglAddon,
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: harness.FakeSerializeAddon,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: harness.FakeTerminal,
}));

import TerminalViewport from "./TerminalViewport";

const decoder = new TextDecoder();
let container: HTMLDivElement;
let root: Root;

describe("TerminalViewport", () => {
  beforeEach(() => {
    harness.reset();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    globalThis.ResizeObserver = class ResizeObserverShim {
      callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe() {}

      unobserve() {}

      disconnect() {}

      takeRecords() {
        return [];
      }
    } as unknown as typeof ResizeObserver;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flush();
    });
    container.remove();
  });

  it("routes alternate-screen and cursor visibility frames through the viewport write path", async () => {
    harness.getTerminalFrameMock.mockResolvedValueOnce(makeFrame(true, "\u001b[?25lALT"));

    await renderViewport();

    const terminal = lastTerminal();
    expect(harness.terminalResizeMock).toHaveBeenCalledWith("session-1", 80, 24);
    expect(terminal.focused).toBe(true);
    expect(decodeWrites(terminal)).toEqual(["\u001b[?1049h\u001b[?25lALT"]);
    expect(harness.listenMock).toHaveBeenCalledWith("term:frame", expect.any(Function));

    await act(async () => {
      harness.emit("term:frame", {
        session_id: "session-1",
        frame: makeFrame(false, "\u001b[?25hMAIN"),
      } satisfies TerminalFrameEvent);
      await flush();
    });

    expect(decodeWrites(terminal)).toEqual([
      "\u001b[?1049h\u001b[?25lALT",
      "\u001b[?1049l\u001b[?25hMAIN",
    ]);
  });

  it("copies reversed wide-char selections from scrollback through the host copy listener", async () => {
    await renderViewport();

    const terminal = lastTerminal();
    terminal.buffer.active = createScrollbackBuffer();
    terminal.selectionPosition = {
      start: { x: 5, y: 0 },
      end: { x: 3, y: 0 },
    };

    const writes: Array<{ format: string; value: string }> = [];
    let prevented = false;
    const host = container.querySelector('[data-testid="terminal-host"]');
    expect(host).not.toBeNull();

    await act(async () => {
      const event = new Event("copy", { bubbles: true, cancelable: true }) as Event & {
        clipboardData?: { setData(format: string, value: string): void };
      };
      Object.defineProperty(event, "clipboardData", {
        configurable: true,
        value: {
          setData(format: string, value: string) {
            writes.push({ format, value });
          },
        },
      });
      const originalPreventDefault = event.preventDefault.bind(event);
      event.preventDefault = () => {
        prevented = true;
        originalPreventDefault();
      };
      host?.dispatchEvent(event);
      await flush();
    });

    expect(writes).toEqual([{ format: "text/plain", value: "界x" }]);
    expect(prevented).toBe(true);
  });

  it("restores a serialized buffer before waiting for live frames", async () => {
    await renderViewport({
      restoredSnapshot: {
        capturedAtMs: 123,
        cols: 80,
        rows: 24,
        serializedBuffer: "RESTORED",
      },
    });

    const terminal = lastTerminal();
    expect(harness.getTerminalFrameMock).not.toHaveBeenCalled();
    expect(decodeWrites(terminal)).toEqual(["RESTORED"]);

    await act(async () => {
      harness.emit("term:frame", {
        session_id: "session-1",
        frame: makeFrame(false, "\u001b[H\u001b[2JLIVE"),
      } satisfies TerminalFrameEvent);
      await flush();
    });

    expect(decodeWrites(terminal)).toEqual(["RESTORED", "\u001b[H\u001b[2JLIVE"]);
  });
});

function decodeWrites(terminal: InstanceType<typeof harness.FakeTerminal>): string[] {
  return terminal.writes.map((bytes) =>
    typeof bytes === "string" ? bytes : decoder.decode(bytes),
  );
}

function lastTerminal(): InstanceType<typeof harness.FakeTerminal> {
  const terminal = harness.FakeTerminal.instances.at(-1);
  expect(terminal).toBeDefined();
  return terminal!;
}

async function renderViewport(
  props: {
    blocked?: boolean;
    focused?: boolean;
    restoredSnapshot?: {
      capturedAtMs: number;
      cols: number;
      rows: number;
      serializedBuffer: string;
    } | null;
  } = {},
) {
  await act(async () => {
    root.render(
      <TerminalViewport
        blocked={props.blocked ?? false}
        focused={props.focused ?? true}
        onActivate={() => {}}
        restoredSnapshot={props.restoredSnapshot ?? null}
        sessionId="session-1"
      />,
    );
    await flush();
  });
}

function makeFrame(alternateScreen: boolean, ansi: string) {
  return {
    ansi: Array.from(new TextEncoder().encode(ansi)),
    cursor_x: 0,
    cursor_y: 0,
    cursor_visible: !ansi.includes("?25l"),
    display_offset: 0,
    total_lines: 0,
    alternate_screen: alternateScreen,
  };
}

function createScrollbackBuffer(): SelectionBuffer {
  return {
    getLine(line: number) {
      if (line === 0) {
        return makeLine("aa界x");
      }
      if (line === 1) {
        return makeLine("bb");
      }
      return undefined;
    },
  };
}

function makeLine(value: string) {
  const columns = value === "aa界x" ? ["a", "a", "界", "", "x"] : Array.from(value);
  return {
    isWrapped: false,
    length: columns.length,
    getCell(column: number) {
      if (column < 0 || column >= columns.length) {
        return undefined;
      }
      if (value === "aa界x" && column === 3) {
        return { getWidth: () => 0 };
      }
      return { getWidth: () => 1 };
    },
    translateToString(_trimRight?: boolean, startColumn = 0, endColumn = columns.length) {
      if (value !== "aa界x") {
        return value.slice(startColumn, endColumn);
      }
      return columns.slice(startColumn, endColumn).join("");
    },
  };
}

function emptySelectionBuffer(): SelectionBuffer {
  return {
    getLine(_line: number) {
      return undefined;
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}
