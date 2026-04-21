import { useEffect, useState } from "react";

import {
  DEFAULT_KEYBOARD_MODE,
  type KeyboardMode,
} from "../app/keybindings";

const STORAGE_KEY = "lastty:keybinding-mode";

function readStored(): KeyboardMode {
  if (typeof window === "undefined") return DEFAULT_KEYBOARD_MODE;
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "tmux" ? "tmux" : DEFAULT_KEYBOARD_MODE;
}

export function useKeyboardMode() {
  const [mode, setMode] = useState<KeyboardMode>(() => readStored());

  useEffect(() => {
    if (mode === DEFAULT_KEYBOARD_MODE) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return { mode, setMode };
}
