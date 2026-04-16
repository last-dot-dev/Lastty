import type { TerminalFrame } from "../lib/ipc";

const ENTER_ALT_SCREEN = new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]);
const EXIT_ALT_SCREEN = new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c]);

export interface XtermFrameState {
  alternateScreen: boolean;
}

export function prepareXtermFrameWrite(
  frame: TerminalFrame,
  previousState: XtermFrameState | null,
): { bytes: Uint8Array; state: XtermFrameState } {
  const body = Uint8Array.from(frame.ansi);
  const modePrefix = selectAltScreenPrefix(frame.alternate_screen, previousState);
  return {
    bytes: modePrefix ? concatBytes(modePrefix, body) : body,
    state: { alternateScreen: frame.alternate_screen },
  };
}

function selectAltScreenPrefix(
  nextAlternateScreen: boolean,
  previousState: XtermFrameState | null,
): Uint8Array | null {
  if (nextAlternateScreen) {
    return previousState?.alternateScreen ? null : ENTER_ALT_SCREEN;
  }
  return previousState?.alternateScreen ? EXIT_ALT_SCREEN : null;
}

function concatBytes(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}
