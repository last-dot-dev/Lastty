// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import KeyboardHelpOverlay from "./KeyboardHelpOverlay";

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

describe("KeyboardHelpOverlay", () => {
  it("renders nothing when closed", () => {
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={false}
          mode="standard"
          platform="mac"
          onClose={() => {}}
        />,
      );
    });
    expect(container.querySelector(".keyboard-help-overlay")).toBeNull();
  });

  it("renders all categories when open", () => {
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="mac"
          onClose={() => {}}
        />,
      );
    });
    const titles = Array.from(
      container.querySelectorAll<HTMLHeadingElement>(".keyboard-help-section-title"),
    ).map((el) => el.textContent);
    expect(titles).toEqual(["Navigation", "Panes", "Desktops", "Help"]);
  });

  it("renders mac-style key labels when platform is mac", () => {
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="mac"
          onClose={() => {}}
        />,
      );
    });
    const kbds = Array.from(
      container.querySelectorAll<HTMLElement>(".keyboard-help-kbd"),
    ).map((el) => el.textContent);
    expect(kbds).toContain("⌘⌃H");
    expect(kbds).toContain("⌘⌃/");
  });

  it("renders ctrl+shift labels when platform is other", () => {
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="other"
          onClose={() => {}}
        />,
      );
    });
    const kbds = Array.from(
      container.querySelectorAll<HTMLElement>(".keyboard-help-kbd"),
    ).map((el) => el.textContent);
    expect(kbds).toContain("Ctrl+Shift+H");
    expect(kbds).toContain("Ctrl+Shift+/");
  });

  it("calls onClose when Esc is pressed", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="mac"
          onClose={onClose}
        />,
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="mac"
          onClose={onClose}
        />,
      );
    });
    const overlay = container.querySelector<HTMLDivElement>(".keyboard-help-overlay");
    act(() => {
      overlay?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when the panel itself is clicked", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="mac"
          onClose={onClose}
        />,
      );
    });
    const panel = container.querySelector<HTMLDivElement>(".keyboard-help-panel");
    act(() => {
      panel?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="mac"
          onClose={onClose}
        />,
      );
    });
    const close = container.querySelector<HTMLButtonElement>(".keyboard-help-close");
    act(() => {
      close?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nine desktop jump rows", () => {
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="standard"
          platform="mac"
          onClose={() => {}}
        />,
      );
    });
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>(".keyboard-help-label"),
    ).map((el) => el.textContent);
    for (let n = 1; n <= 9; n += 1) {
      expect(labels).toContain(`Jump to desktop ${n}`);
    }
  });

  it("renders tmux sequences when tmux mode is active", () => {
    act(() => {
      root.render(
        <KeyboardHelpOverlay
          open={true}
          mode="tmux"
          platform="other"
          onClose={() => {}}
        />,
      );
    });
    const kbds = Array.from(
      container.querySelectorAll<HTMLElement>(".keyboard-help-kbd"),
    ).map((el) => el.textContent);
    const thens = Array.from(
      container.querySelectorAll<HTMLElement>(".keyboard-help-then"),
    ).map((el) => el.textContent);
    expect(kbds).toContain("Ctrl+A");
    expect(kbds).toContain("Shift+|");
    expect(kbds).toContain("Ctrl+L");
    expect(thens).toContain("then");
  });
});
