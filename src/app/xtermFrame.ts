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
  const body = decodeBase64(frame.ansi);
  const modePrefix = selectAltScreenPrefix(frame.alternate_screen, previousState);
  return {
    bytes: modePrefix ? concatBytes(modePrefix, body) : body,
    state: { alternateScreen: frame.alternate_screen },
  };
}

// Prefer the native binary decoder (WebKit has shipped `Uint8Array.fromBase64`)
// since it skips the atob string + charCodeAt copy loop. Fall back to atob for
// older runtimes — still vastly cheaper than JSON-parsing a number array.
const nativeFromBase64 = (Uint8Array as unknown as {
  fromBase64?: (s: string) => Uint8Array;
}).fromBase64;

function decodeBase64(s: string): Uint8Array {
  if (nativeFromBase64) return nativeFromBase64(s);
  const binary = atob(s);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
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
