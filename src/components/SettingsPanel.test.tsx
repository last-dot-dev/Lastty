// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPanel from "./SettingsPanel";

const APPEARANCE_PROPS = {
  accent: "blue" as const,
  fontFamily: "System Default" as const,
  fontSize: 14,
  onAccentChange: () => {},
  onFontFamilyChange: () => {},
  onFontSizeChange: () => {},
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("SettingsPanel", () => {
  it("renders nothing when closed", () => {
    act(() => {
      root.render(
        <SettingsPanel
          open={false}
          keyboardMode="standard"
          themeOverride="system"
          onKeyboardModeChange={() => {}}
          onThemeOverrideChange={() => {}}
          onClose={() => {}}
          {...APPEARANCE_PROPS}
        />,
      );
    });
    expect(container.querySelector(".settings-overlay")).toBeNull();
  });

  it("calls handlers when switching keyboard mode and theme", () => {
    const onKeyboardModeChange = vi.fn();
    const onThemeOverrideChange = vi.fn();

    act(() => {
      root.render(
        <SettingsPanel
          open={true}
          keyboardMode="standard"
          themeOverride="system"
          onKeyboardModeChange={onKeyboardModeChange}
          onThemeOverrideChange={onThemeOverrideChange}
          onClose={() => {}}
          {...APPEARANCE_PROPS}
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const tmux = buttons.find((button) => button.textContent?.includes("Tmux-like"));
    const dark = buttons.find((button) => button.textContent === "dark");

    act(() => {
      tmux?.click();
      dark?.click();
    });

    expect(onKeyboardModeChange).toHaveBeenCalledWith("tmux");
    expect(onThemeOverrideChange).toHaveBeenCalledWith("dark");
  });

  it("calls onClose when escape is pressed", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <SettingsPanel
          open={true}
          keyboardMode="standard"
          themeOverride="system"
          onKeyboardModeChange={() => {}}
          onThemeOverrideChange={() => {}}
          onClose={onClose}
          {...APPEARANCE_PROPS}
        />,
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
