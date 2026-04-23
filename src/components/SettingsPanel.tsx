import { useEffect, useRef } from "react";

import type { KeyboardMode } from "../app/keybindings";
import type { ThemeOverride } from "../hooks/useThemeOverride";
import {
  ACCENT_COLORS,
  DEFAULT_FONT_FAMILY,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useInstalledMonospaceFonts,
  type AccentColor,
  type FontFamily,
} from "../hooks/useAppearance";

const THEME_OPTIONS: ThemeOverride[] = ["system", "light", "dark"];
const ACCENT_OPTIONS = Object.keys(ACCENT_COLORS) as AccentColor[];

export interface SettingsPanelProps {
  open: boolean;
  keyboardMode: KeyboardMode;
  themeOverride: ThemeOverride;
  accent: AccentColor;
  fontFamily: FontFamily;
  fontSize: number;
  showGitGraph: boolean;
  onKeyboardModeChange: (mode: KeyboardMode) => void;
  onThemeOverrideChange: (override: ThemeOverride) => void;
  onAccentChange: (accent: AccentColor) => void;
  onFontFamilyChange: (family: FontFamily) => void;
  onFontSizeChange: (size: number) => void;
  onShowGitGraphChange: (show: boolean) => void;
  onClose: () => void;
}

export default function SettingsPanel({
  open,
  keyboardMode,
  themeOverride,
  accent,
  fontFamily,
  fontSize,
  showGitGraph,
  onKeyboardModeChange,
  onThemeOverrideChange,
  onAccentChange,
  onFontFamilyChange,
  onFontSizeChange,
  onShowGitGraphChange,
  onClose,
}: SettingsPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const installedFonts = useInstalledMonospaceFonts();
  const fontOptions: FontFamily[] = [DEFAULT_FONT_FAMILY, ...installedFonts];
  if (!fontOptions.includes(fontFamily)) {
    fontOptions.push(fontFamily);
  }

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
          <div className="settings-section-title">Theme</div>
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

        <section className="settings-section">
          <div className="settings-section-title">Accent color</div>
          <div
            aria-label="Accent color"
            className="settings-swatch-row"
            role="group"
          >
            {ACCENT_OPTIONS.map((option) => (
              <button
                aria-label={option}
                aria-pressed={accent === option}
                className={`settings-swatch${accent === option ? " is-active" : ""}`}
                key={option}
                onClick={() => onAccentChange(option)}
                style={{ background: ACCENT_COLORS[option] }}
                type="button"
              />
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">Font</div>
          <div className="settings-option-grid">
            <label className="settings-field">
              <span className="settings-field-label">Family</span>
              <select
                aria-label="Font family"
                className="settings-select"
                onChange={(event) => onFontFamilyChange(event.target.value)}
                value={fontFamily}
              >
                {fontOptions.map((family) => (
                  <option
                    key={family}
                    value={family}
                    style={
                      family === DEFAULT_FONT_FAMILY
                        ? undefined
                        : { fontFamily: `"${family}", monospace` }
                    }
                  >
                    {family}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field-label">
                Size ({MIN_FONT_SIZE}–{MAX_FONT_SIZE}px)
              </span>
              <div className="settings-stepper">
                <button
                  aria-label="Decrease font size"
                  className="settings-stepper-btn"
                  disabled={fontSize <= MIN_FONT_SIZE}
                  onClick={() => onFontSizeChange(fontSize - 1)}
                  type="button"
                >
                  −
                </button>
                <input
                  aria-label="Font size"
                  className="settings-number"
                  max={MAX_FONT_SIZE}
                  min={MIN_FONT_SIZE}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) onFontSizeChange(next);
                  }}
                  type="number"
                  value={fontSize}
                />
                <button
                  aria-label="Increase font size"
                  className="settings-stepper-btn"
                  disabled={fontSize >= MAX_FONT_SIZE}
                  onClick={() => onFontSizeChange(fontSize + 1)}
                  type="button"
                >
                  +
                </button>
              </div>
            </label>
          </div>
          <div className="settings-note">
            Applies to the terminal and UI monospaced text. Pick a font you have installed
            locally; the app falls back to the system mono stack.
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">Sidebar</div>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={showGitGraph}
              onChange={(event) => onShowGitGraphChange(event.target.checked)}
            />
            <span>
              <span className="settings-option-label">Show git graph</span>
              <span className="settings-option-copy">
                Adds a commit-graph panel below Sessions in the sidebar.
              </span>
            </span>
          </label>
        </section>
      </div>
    </div>
  );
}
