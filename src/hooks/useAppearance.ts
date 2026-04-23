import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createElement } from "react";

import { listMonospaceFonts } from "../lib/ipc";

export type AccentColor = "blue" | "purple" | "green" | "orange" | "pink" | "amber";

export const ACCENT_COLORS: Record<AccentColor, string> = {
  blue: "#378ADD",
  purple: "#7F77DD",
  green: "#1D9E75",
  orange: "#D85A30",
  pink: "#D4537E",
  amber: "#BA7517",
};

export type FontFamily = string;

export const DEFAULT_FONT_FAMILY: FontFamily = "System Default";
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_ACCENT: AccentColor = "blue";
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 22;

const FONT_FAMILY_KEY = "lastty:font-family";
const FONT_SIZE_KEY = "lastty:font-size";
const ACCENT_KEY = "lastty:accent";

const SYSTEM_MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function readFontFamily(): FontFamily {
  if (typeof window === "undefined") return DEFAULT_FONT_FAMILY;
  const value = window.localStorage.getItem(FONT_FAMILY_KEY);
  return value && value.trim() ? value : DEFAULT_FONT_FAMILY;
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
  if (family === DEFAULT_FONT_FAMILY) return SYSTEM_MONO_STACK;
  return `"${family}", ${SYSTEM_MONO_STACK}`;
}

export function xtermFontFamily(family: FontFamily): string {
  if (family === DEFAULT_FONT_FAMILY) return "Menlo, NFFallback, Monaco, monospace";
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

interface TerminalFontContextValue {
  fontFamily: FontFamily;
  fontSize: number;
}

const TerminalFontContext = createContext<TerminalFontContextValue>({
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
});

export function TerminalFontProvider({
  fontFamily,
  fontSize,
  children,
}: {
  fontFamily: FontFamily;
  fontSize: number;
  children: ReactNode;
}) {
  return createElement(
    TerminalFontContext.Provider,
    { value: { fontFamily, fontSize } },
    children,
  );
}

export function useTerminalFont(): TerminalFontContextValue {
  return useContext(TerminalFontContext);
}

export function useInstalledMonospaceFonts(): FontFamily[] {
  const [fonts, setFonts] = useState<FontFamily[]>([]);

  useEffect(() => {
    let cancelled = false;
    listMonospaceFonts()
      .then((list) => {
        if (cancelled) return;
        setFonts(list);
      })
      .catch(() => {
        if (cancelled) return;
        setFonts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return fonts;
}
