// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { BINDINGS, formatKey, matchBinding, type Platform } from "./keybindings";

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

function bindingFor(id: string) {
  return BINDINGS.find((b) => b.id === id && b.payload === undefined);
}

describe("matchBinding", () => {
  describe("mac", () => {
    const p: Platform = "mac";

    it("matches Cmd+Ctrl+H to focus.left", () => {
      const match = matchBinding(keyEvent({ key: "h", meta: true, ctrl: true }), p);
      expect(match?.binding.id).toBe("focus.left");
    });

    it("matches Cmd+Ctrl+ArrowLeft to focus.left", () => {
      const match = matchBinding(
        keyEvent({ key: "ArrowLeft", meta: true, ctrl: true }),
        p,
      );
      expect(match?.binding.id).toBe("focus.left");
    });

    it("does NOT match Ctrl+Shift+H on mac", () => {
      const match = matchBinding(keyEvent({ key: "H", ctrl: true, shift: true }), p);
      expect(match).toBeNull();
    });

    it("matches Cmd+Ctrl+S to pane.split.horizontal regardless of shift", () => {
      const match = matchBinding(
        keyEvent({ key: "S", meta: true, ctrl: true, shift: true }),
        p,
      );
      expect(match?.binding.id).toBe("pane.split.horizontal");
    });

    it("matches Cmd+Ctrl+/ to help.toggle", () => {
      const match = matchBinding(keyEvent({ key: "/", meta: true, ctrl: true }), p);
      expect(match?.binding.id).toBe("help.toggle");
    });

    it("does not match when alt is held", () => {
      const match = matchBinding(
        keyEvent({ key: "h", meta: true, ctrl: true, alt: true }),
        p,
      );
      expect(match).toBeNull();
    });

    it("matches Cmd+Ctrl+1 to desktop.jump with payload 1", () => {
      const match = matchBinding(keyEvent({ key: "1", meta: true, ctrl: true }), p);
      expect(match?.binding.id).toBe("desktop.jump");
      expect(match?.binding.payload).toBe(1);
    });

    it("matches Cmd+Ctrl+9 to desktop.jump with payload 9", () => {
      const match = matchBinding(keyEvent({ key: "9", meta: true, ctrl: true }), p);
      expect(match?.binding.payload).toBe(9);
    });
  });

  describe("other (linux/windows)", () => {
    const p: Platform = "other";

    it("matches Ctrl+Shift+H to focus.left", () => {
      const match = matchBinding(keyEvent({ key: "H", ctrl: true, shift: true }), p);
      expect(match?.binding.id).toBe("focus.left");
    });

    it("matches Ctrl+Shift+ArrowLeft to focus.left", () => {
      const match = matchBinding(
        keyEvent({ key: "ArrowLeft", ctrl: true, shift: true }),
        p,
      );
      expect(match?.binding.id).toBe("focus.left");
    });

    it("does NOT match Cmd+Ctrl+H on other", () => {
      const match = matchBinding(
        keyEvent({ key: "h", meta: true, ctrl: true }),
        p,
      );
      expect(match).toBeNull();
    });

    it("matches Ctrl+Shift+/ to help.toggle", () => {
      const match = matchBinding(
        keyEvent({ key: "/", ctrl: true, shift: true }),
        p,
      );
      expect(match?.binding.id).toBe("help.toggle");
    });

    it("matches Ctrl+Shift+] to desktop.next", () => {
      const match = matchBinding(
        keyEvent({ key: "]", ctrl: true, shift: true }),
        p,
      );
      expect(match?.binding.id).toBe("desktop.next");
    });

    it("does not match plain letters without modifiers", () => {
      expect(matchBinding(keyEvent({ key: "h" }), p)).toBeNull();
    });
  });

  it("returns null when no binding matches", () => {
    const match = matchBinding(keyEvent({ key: "z", meta: true, ctrl: true }), "mac");
    expect(match).toBeNull();
  });
});

describe("formatKey", () => {
  it("formats letter on mac with ⌘⌃ prefix and uppercase", () => {
    const spec = bindingFor("focus.left")!.keys[0];
    expect(formatKey(spec, "mac")).toBe("⌘⌃H");
  });

  it("formats letter on other with Ctrl+Shift prefix and uppercase", () => {
    const spec = bindingFor("focus.left")!.keys[0];
    expect(formatKey(spec, "other")).toBe("Ctrl+Shift+H");
  });

  it("formats arrow keys as glyphs", () => {
    expect(formatKey({ key: "ArrowLeft" }, "mac")).toBe("⌘⌃←");
    expect(formatKey({ key: "ArrowDown" }, "other")).toBe("Ctrl+Shift+↓");
  });

  it("preserves bracket and slash characters as-is", () => {
    expect(formatKey({ key: "/" }, "mac")).toBe("⌘⌃/");
    expect(formatKey({ key: "]" }, "other")).toBe("Ctrl+Shift+]");
  });
});

describe("BINDINGS registry", () => {
  it("contains exactly nine desktop.jump entries with payloads 1-9", () => {
    const jumps = BINDINGS.filter((b) => b.id === "desktop.jump");
    expect(jumps).toHaveLength(9);
    expect(jumps.map((b) => b.payload)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("has one entry per non-jump action id", () => {
    const ids = BINDINGS.filter((b) => b.id !== "desktop.jump").map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
