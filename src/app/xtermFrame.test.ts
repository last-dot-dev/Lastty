import { describe, expect, it } from "vitest";

import type { TerminalFrame } from "../lib/ipc";

import { prepareXtermFrameWrite } from "./xtermFrame";

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
    ansi: Array.from(new TextEncoder().encode(ansi)),
    cursor_x: 0,
    cursor_y: 0,
    cursor_visible: true,
    display_offset: 0,
    total_lines: 0,
    alternate_screen: alternateScreen,
  };
}
