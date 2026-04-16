import { useEffect, useRef } from "react";

import {
  BINDINGS,
  formatKey,
  type Binding,
  type Category,
  type Platform,
} from "../app/keybindings";

const CATEGORY_ORDER: Category[] = ["Navigation", "Panes", "Desktops", "Help"];

export interface KeyboardHelpOverlayProps {
  open: boolean;
  platform: Platform;
  onClose: () => void;
}

export default function KeyboardHelpOverlay({
  open,
  platform,
  onClose,
}: KeyboardHelpOverlayProps) {
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
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  const grouped = groupByCategory(BINDINGS);

  return (
    <div
      className="keyboard-help-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-labelledby="keyboard-help-title"
        aria-modal="true"
        className="keyboard-help-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="keyboard-help-header">
          <div>
            <div className="keyboard-help-eyebrow">Keyboard Shortcuts</div>
            <div className="keyboard-help-subtitle" id="keyboard-help-title">
              {platform === "mac" ? "⌘⌃ + key" : "Ctrl+Shift + key"}
            </div>
          </div>
          <button
            aria-label="Close shortcut help"
            className="keyboard-help-close"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="keyboard-help-grid">
          {CATEGORY_ORDER.map((category) => {
            const items = grouped.get(category);
            if (!items || items.length === 0) return null;
            return (
              <section className="keyboard-help-section" key={category}>
                <h3 className="keyboard-help-section-title">{category}</h3>
                <ul className="keyboard-help-list">
                  {items.map((binding) => (
                    <li className="keyboard-help-row" key={rowKey(binding)}>
                      <span className="keyboard-help-label">{binding.label}</span>
                      <span className="keyboard-help-keys">
                        {binding.keys.map((spec, index) => (
                          <span className="keyboard-help-keys-group" key={index}>
                            {index > 0 && (
                              <span className="keyboard-help-or">or</span>
                            )}
                            <kbd className="keyboard-help-kbd">
                              {formatKey(spec, platform)}
                            </kbd>
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function groupByCategory(bindings: Binding[]): Map<Category, Binding[]> {
  const map = new Map<Category, Binding[]>();
  for (const binding of bindings) {
    const list = map.get(binding.category) ?? [];
    list.push(binding);
    map.set(binding.category, list);
  }
  return map;
}

function rowKey(binding: Binding): string {
  return binding.payload === undefined ? binding.id : `${binding.id}:${binding.payload}`;
}
