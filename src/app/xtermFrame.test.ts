// @vitest-environment jsdom

import xtermPkg from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import type { TerminalFrame } from "../lib/ipc";

import { prepareXtermFrameWrite, type XtermFrameState } from "./xtermFrame";
import { encodeAnsiBase64 } from "./xtermFrame.testUtils";

const { Terminal } = xtermPkg;
const decoder = new TextDecoder();

describe("prepareXtermFrameWrite", () => {
  it("enters the alternate screen for the first alternate-screen frame", () => {
    const result = prepareXtermFrameWrite(makeFrame(true, "\u001b[Halt"), null);

    expect(decoder.decode(result.bytes)).toBe("\u001b[?1049h\u001b[Halt");
    expect(result.state).toEqual({ alternateScreen: true });
  });

  it("leaves the alternate screen when a later frame returns to the main screen", () => {
    const result = prepareXtermFrameWrite(makeFrame(false, "\u001b[Hmain"), {
      alternateScreen: true,
    });

    expect(decoder.decode(result.bytes)).toBe("\u001b[?1049l\u001b[Hmain");
    expect(result.state).toEqual({ alternateScreen: false });
  });

  it("does not resend alternate-screen switches when the mode is unchanged", () => {
    const result = prepareXtermFrameWrite(makeFrame(true, "\u001b[Hsteady"), {
      alternateScreen: true,
    });

    expect(decoder.decode(result.bytes)).toBe("\u001b[Hsteady");
  });
});

function makeFrame(alternateScreen: boolean, ansi: string): TerminalFrame {
  return {
    ansi: encodeAnsiBase64(ansi),
    cursor_x: 0,
    cursor_y: 0,
    cursor_visible: true,
    display_offset: 0,
    total_lines: 0,
    alternate_screen: alternateScreen,
  };
}

describe("xterm buffer switching under frame transitions", () => {
  // Lastty configures xterm.js with scrollback: 0 so Rust's alacritty owns the
  // sole scrollback buffer; xterm.js is just a display surface. These tests
  // mirror that configuration.
  it("keeps the main buffer active and pinned to the viewport while main-screen frames arrive", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 3, scrollback: 0 });
    const lines = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\r\n");

    writeSequence(term, [makeFrame(false, lines)]);
    await flushXterm();

    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.baseY).toBe(0);
  });

  it("switches to the alternate buffer once alt-screen frames arrive", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 3, scrollback: 0 });
    const history = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\r\n");

    writeSequence(term, [
      makeFrame(false, history),
      makeFrame(true, "\u001b[HTUI"),
    ]);
    await flushXterm();

    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.baseY).toBe(0);
  });

  it("returns to the main buffer when the session exits alt-screen", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 3, scrollback: 0 });
    const history = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\r\n");

    writeSequence(term, [
      makeFrame(false, history),
      makeFrame(true, "\u001b[HTUI"),
      makeFrame(false, ""),
    ]);
    await flushXterm();

    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.baseY).toBe(0);
  });
});

function writeSequence(term: InstanceType<typeof Terminal>, frames: TerminalFrame[]) {
  let state: XtermFrameState | null = null;
  for (const frame of frames) {
    const { bytes, state: next } = prepareXtermFrameWrite(frame, state);
    term.write(bytes);
    state = next;
  }
}

async function flushXterm() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
