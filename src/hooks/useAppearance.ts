import { useCallback, useEffect, useState } from "react";

export type AccentColor = "blue" | "purple" | "green" | "orange" | "pink" | "amber";

export const ACCENT_COLORS: Record<AccentColor, string> = {
  blue: "#378ADD",
  purple: "#7F77DD",
  green: "#1D9E75",
  orange: "#D85A30",
  pink: "#D4537E",
  amber: "#BA7517",
};

export const FONT_FAMILIES = [
  "System Default",
  "Menlo",
  "Monaco",
  "SF Mono",
  "JetBrains Mono",
  "Fira Code",
  "Hack",
  "Iosevka Term",
  "Cascadia Code",
] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];

export const DEFAULT_FONT_FAMILY: FontFamily = "System Default";
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_ACCENT: AccentColor = "blue";
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 22;

const FONT_FAMILY_KEY = "lastty:font-family";
const FONT_SIZE_KEY = "lastty:font-size";
const ACCENT_KEY = "lastty:accent";

const SYSTEM_MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function isFontFamily(value: string | null): value is FontFamily {
  return !!value && (FONT_FAMILIES as readonly string[]).includes(value);
}

function readFontFamily(): FontFamily {
  if (typeof window === "undefined") return DEFAULT_FONT_FAMILY;
  const value = window.localStorage.getItem(FONT_FAMILY_KEY);
  return isFontFamily(value) ? value : DEFAULT_FONT_FAMILY;
}

function readFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  const value = Number(window.localStorage.getItem(FONT_SIZE_KEY));
  if (!Number.isFinite(value) || value < MIN_FONT_SIZE || value > MAX_FONT_SIZE) {
    return DEFAULT_FONT_SIZE;
  }
  return value;
}

function readAccent(): AccentColor {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  const value = window.localStorage.getItem(ACCENT_KEY);
  if (value && value in ACCENT_COLORS) return value as AccentColor;
  return DEFAULT_ACCENT;
}

export function fontFamilyStack(family: FontFamily): string {
  if (family === "System Default") return SYSTEM_MONO_STACK;
  return `"${family}", ${SYSTEM_MONO_STACK}`;
}

export function xtermFontFamily(family: FontFamily): string {
  if (family === "System Default") return "Menlo, NFFallback, Monaco, monospace";
  return `"${family}", NFFallback, Menlo, Monaco, monospace`;
}

function applyAccent(color: AccentColor) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--accent", ACCENT_COLORS[color]);
}

function applyFontCss(family: FontFamily, size: number) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--font-mono", fontFamilyStack(family));
  root.style.setProperty("--terminal-font-size", `${size}px`);
}

export function useAppearance() {
  const [fontFamily, setFontFamilyState] = useState<FontFamily>(() => readFontFamily());
  const [fontSize, setFontSizeState] = useState<number>(() => readFontSize());
  const [accent, setAccentState] = useState<AccentColor>(() => readAccent());

  useEffect(() => {
    applyFontCss(fontFamily, fontSize);
    if (fontFamily === DEFAULT_FONT_FAMILY) {
      window.localStorage.removeItem(FONT_FAMILY_KEY);
    } else {
      window.localStorage.setItem(FONT_FAMILY_KEY, fontFamily);
    }
    if (fontSize === DEFAULT_FONT_SIZE) {
      window.localStorage.removeItem(FONT_SIZE_KEY);
    } else {
      window.localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
    }
  }, [fontFamily, fontSize]);

  useEffect(() => {
    applyAccent(accent);
    if (accent === DEFAULT_ACCENT) {
      window.localStorage.removeItem(ACCENT_KEY);
    } else {
      window.localStorage.setItem(ACCENT_KEY, accent);
    }
  }, [accent]);

  const setFontFamily = useCallback((value: FontFamily) => setFontFamilyState(value), []);
  const setFontSize = useCallback((value: number) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)));
    setFontSizeState(clamped);
  }, []);
  const setAccent = useCallback((value: AccentColor) => setAccentState(value), []);

  return { fontFamily, fontSize, accent, setFontFamily, setFontSize, setAccent };
}
