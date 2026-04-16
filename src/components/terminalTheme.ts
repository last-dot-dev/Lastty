import type { ITheme } from "@xterm/xterm";

export const XTERM_THEME_DARK: ITheme = {
  background: "#0F1219",
  foreground: "#D6D9E0",
  cursor: "#F4F5F7",
  cursorAccent: "#0F1219",
  selectionBackground: "rgba(95, 135, 215, 0.35)",
  black: "#1D2230",
  red: "#FF8E8E",
  green: "#A9D066",
  yellow: "#F5BF66",
  blue: "#7FB0FF",
  magenta: "#D4A0FF",
  cyan: "#7DD3C0",
  white: "#D6D9E0",
  brightBlack: "#6B7387",
  brightRed: "#FF9E95",
  brightGreen: "#BDDD7F",
  brightYellow: "#FAD79A",
  brightBlue: "#9FC6FF",
  brightMagenta: "#E2B6FF",
  brightCyan: "#9FE3D4",
  brightWhite: "#EDEFF5",
};

export const XTERM_THEME_LIGHT: ITheme = {
  background: "#FDFCF7",
  foreground: "#3F3A2B",
  cursor: "#3F3A2B",
  cursorAccent: "#FDFCF7",
  selectionBackground: "rgba(29, 92, 154, 0.18)",
  black: "#3F3A2B",
  red: "#A53C2B",
  green: "#3B6B15",
  yellow: "#854F0B",
  blue: "#1D5C9A",
  magenta: "#8C3B7A",
  cyan: "#1C7877",
  white: "#6B6247",
  brightBlack: "#9A917A",
  brightRed: "#C14C36",
  brightGreen: "#4E8A1B",
  brightYellow: "#A66612",
  brightBlue: "#2A79BF",
  brightMagenta: "#A64A91",
  brightCyan: "#26968F",
  brightWhite: "#3F3A2B",
};

export function xtermThemeFor(effective: "light" | "dark"): ITheme {
  return effective === "light" ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
}
