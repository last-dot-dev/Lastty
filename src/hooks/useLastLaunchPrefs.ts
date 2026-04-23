import { useCallback, useState } from "react";

const STORAGE_KEY = "lastty:last-launch-prefs";

export interface LastLaunchPrefs {
  useWorktree: boolean;
}

const DEFAULT: LastLaunchPrefs = { useWorktree: false };

function readStored(): LastLaunchPrefs {
  if (typeof window === "undefined") return DEFAULT;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT;
  try {
    const parsed = JSON.parse(raw) as Partial<LastLaunchPrefs>;
    return { useWorktree: Boolean(parsed.useWorktree) };
  } catch {
    return DEFAULT;
  }
}

export function useLastLaunchPrefs() {
  const [prefs, setPrefsState] = useState<LastLaunchPrefs>(() => readStored());

  const setPrefs = useCallback((next: LastLaunchPrefs) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setPrefsState(next);
  }, []);

  return { prefs, setPrefs };
}
