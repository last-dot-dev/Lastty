import { useEffect, useRef } from "react";

import type { KeyboardMode } from "../app/keybindings";
import type { ThemeOverride } from "../hooks/useThemeOverride";

const THEME_OPTIONS: ThemeOverride[] = ["system", "light", "dark"];

export interface SettingsPanelProps {
  open: boolean;
  keyboardMode: KeyboardMode;
  themeOverride: ThemeOverride;
  onKeyboardModeChange: (mode: KeyboardMode) => void;
  onThemeOverrideChange: (override: ThemeOverride) => void;
  onClose: () => void;
}

export default function SettingsPanel({
  open,
  keyboardMode,
  themeOverride,
  onKeyboardModeChange,
  onThemeOverrideChange,
  onClose,
}: SettingsPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        aria-labelledby="settings-title"
        aria-modal="true"
        className="settings-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="settings-header">
          <div>
            <div className="settings-eyebrow">Settings</div>
            <div className="settings-subtitle" id="settings-title">
              Keyboard and appearance
            </div>
          </div>
          <button
            aria-label="Close settings"
            className="settings-close"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            x
          </button>
        </div>

        <section className="settings-section">
          <div className="settings-section-title">Keyboard</div>
          <div className="settings-option-grid">
            <button
              type="button"
              className={`settings-option${keyboardMode === "standard" ? " is-active" : ""}`}
              onClick={() => onKeyboardModeChange("standard")}
            >
              <span className="settings-option-label">Standard</span>
              <span className="settings-option-copy">
                Keep the current app shortcuts. Safe default for shells and editors.
              </span>
            </button>
            <button
              type="button"
              className={`settings-option${keyboardMode === "tmux" ? " is-active" : ""}`}
              onClick={() => onKeyboardModeChange("tmux")}
            >
              <span className="settings-option-label">Tmux-like</span>
              <span className="settings-option-copy">
                Adds Ctrl+A sequences for split right, split below, close, desktop moves,
                and desktop jumps, plus Ctrl+H/J/K/L pane focus.
              </span>
            </button>
          </div>
          <div className="settings-note">
            Tmux-like mode overrides common terminal keys like Ctrl+H and Ctrl+L, so it is
            opt-in.
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">Appearance</div>
          <div className="settings-pill-row" role="group" aria-label="Theme">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={`settings-pill${themeOverride === option ? " is-active" : ""}`}
                onClick={() => onThemeOverrideChange(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
