// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  BINDINGS,
  bindingsForMode,
  formatKey,
  formatShortcut,
  matchBinding,
} from "./keybindings";

interface KeyEventOpts {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
}

function keyEvent({
  key,
  ctrl = false,
  shift = false,
  meta = false,
  alt = false,
}: KeyEventOpts): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: ctrl,
    shiftKey: shift,
    metaKey: meta,
    altKey: alt,
  });
}

function bindingFor(mode: "standard" | "tmux", id: string) {
  return bindingsForMode(mode).find(
    (binding) => binding.id === id && binding.payload === undefined,
  );
}

describe("matchBinding", () => {
  describe("standard mode", () => {
    it("matches Cmd+Ctrl+H to focus.left on mac", () => {
      const result = matchBinding(
        keyEvent({ key: "h", meta: true, ctrl: true }),
        "mac",
        "standard",
      );
      expect(result.match?.binding.id).toBe("focus.left");
    });

    it("matches Ctrl+Shift+ArrowLeft to focus.left on other", () => {
      const result = matchBinding(
        keyEvent({ key: "ArrowLeft", ctrl: true, shift: true }),
        "other",
        "standard",
      );
      expect(result.match?.binding.id).toBe("focus.left");
    });

    it("does not match plain letters without modifiers", () => {
      expect(matchBinding(keyEvent({ key: "h" }), "other", "standard").match).toBeNull();
    });

    it("matches Ctrl+Tab to desktop.next on both platforms", () => {
      expect(
        matchBinding(keyEvent({ key: "Tab", ctrl: true }), "mac", "standard").match?.binding.id,
      ).toBe("desktop.next");
      expect(
        matchBinding(keyEvent({ key: "Tab", ctrl: true }), "other", "standard").match?.binding.id,
      ).toBe("desktop.next");
    });
  });

  describe("tmux mode", () => {
    it("matches Ctrl+H to focus.left", () => {
      const result = matchBinding(
        keyEvent({ key: "h", ctrl: true }),
        "other",
        "tmux",
      );
      expect(result.match?.binding.id).toBe("focus.left");
    });

    it("still matches the standard shortcut in tmux mode", () => {
      const result = matchBinding(
        keyEvent({ key: "h", meta: true, ctrl: true }),
        "mac",
        "tmux",
      );
      expect(result.match?.binding.id).toBe("focus.left");
    });

    it("arms the Ctrl+A prefix for split and captures the event", () => {
      const result = matchBinding(
        keyEvent({ key: "a", ctrl: true }),
        "other",
        "tmux",
      );
      expect(result.match).toBeNull();
      expect(result.capture).toBe(true);
      expect(result.pending).toHaveLength(16);
    });

    it("matches Ctrl+A then | to split pane right", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: "|", shift: true }),
        "other",
        "tmux",
        first.pending,
        200,
      );
      expect(second.match?.binding.id).toBe("pane.split.horizontal");
    });

    it("matches Ctrl+A then | while Ctrl is still held", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: "|", ctrl: true, shift: true }),
        "other",
        "tmux",
        first.pending,
        200,
      );
      expect(second.match?.binding.id).toBe("pane.split.horizontal");
    });

    it("matches Ctrl+A then Shift+Backslash when the browser reports backslash as the key", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: "\\", ctrl: true, shift: true }),
        "other",
        "tmux",
        first.pending,
        200,
      );
      expect(second.match?.binding.id).toBe("pane.split.horizontal");
    });

    it("matches Ctrl+A then - to split pane below", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: "-" }),
        "other",
        "tmux",
        first.pending,
        200,
      );
      expect(second.match?.binding.id).toBe("pane.split.vertical");
    });

    it("matches Ctrl+A then X to close pane", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: "x" }),
        "other",
        "tmux",
        first.pending,
        200,
      );
      expect(second.match?.binding.id).toBe("pane.close");
    });

    it("matches Ctrl+A then > to next desktop", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: ">", shift: true }),
        "other",
        "tmux",
        first.pending,
        200,
      );
      expect(second.match?.binding.id).toBe("desktop.next");
    });

    it("matches Ctrl+A then 3 to jump to desktop 3", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: "3" }),
        "other",
        "tmux",
        first.pending,
        200,
      );
      expect(second.match?.binding.id).toBe("desktop.jump");
      expect(second.match?.binding.payload).toBe(3);
    });

    it("expires the prefix after the timeout", () => {
      const first = matchBinding(keyEvent({ key: "a", ctrl: true }), "other", "tmux", [], 100);
      const second = matchBinding(
        keyEvent({ key: "3" }),
        "other",
        "tmux",
        first.pending,
        2_000,
      );
      expect(second.match).toBeNull();
      expect(second.capture).toBe(false);
    });
  });

  it("returns null when no binding matches", () => {
    const result = matchBinding(
      keyEvent({ key: "z", meta: true, ctrl: true }),
      "mac",
      "standard",
    );
    expect(result.match).toBeNull();
  });
});

describe("formatKey", () => {
  it("formats letter on mac with ⌘⌃ prefix and uppercase", () => {
    const spec = bindingFor("standard", "focus.left")!.shortcuts[0]!.sequence[0]!;
    expect(formatKey(spec, "mac")).toBe("⌘⌃H");
  });

  it("formats ctrl-only bindings without shift on other", () => {
    expect(formatKey({ key: "l", modifiers: "ctrl" }, "other")).toBe("Ctrl+L");
  });

  it("formats unmodified shifted symbols", () => {
    expect(formatKey({ key: "|", shift: true, modifiers: "none" }, "other")).toBe("Shift+|");
  });

  it("formats arrow keys as glyphs", () => {
    expect(formatKey({ key: "ArrowLeft" }, "mac")).toBe("⌘⌃←");
    expect(formatKey({ key: "ArrowDown" }, "other")).toBe("Ctrl+Shift+↓");
  });

  it("formats a multi-step tmux shortcut as separate parts", () => {
    const tmuxSplit = bindingFor("tmux", "pane.split.horizontal")!.shortcuts[1]!;
    expect(formatShortcut(tmuxSplit, "other")).toEqual(["Ctrl+A", "Shift+|"]);
  });
});

describe("BINDINGS registry", () => {
  it("contains exactly nine desktop.jump entries with payloads 1-9", () => {
    const jumps = BINDINGS.filter((binding) => binding.id === "desktop.jump");
    expect(jumps).toHaveLength(9);
    expect(jumps.map((binding) => binding.payload)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps one row per non-jump action id", () => {
    const ids = BINDINGS.filter((binding) => binding.id !== "desktop.jump").map(
      (binding) => binding.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows the tmux jump shortcut for each desktop", () => {
    const jumps = bindingsForMode("tmux").filter(
      (binding) => binding.id === "desktop.jump",
    );
    for (const jump of jumps) {
      expect(jump.shortcuts).toHaveLength(2);
    }
  });
});
