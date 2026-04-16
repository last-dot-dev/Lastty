import { describe, expect, it } from "vitest";

import {
  closePane,
  createPaneRecord,
  createWorkspace,
  findAdjacentPaneId,
  focusAdjacentPane,
  orderedPaneIds,
  resizeSplit,
  resizeSplitWeights,
  splitPane,
} from "./layout";

describe("layout state", () => {
  it("splits the focused pane into a two-child layout", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root);

    const next = createPaneRecord("session-b", "secondary");
    const updated = splitPane(state, root.id, "horizontal", next);

    expect(updated.focusedPaneId).toBe(next.id);
    expect(orderedPaneIds(updated.layout)).toEqual([root.id, next.id]);
  });

  it("collapses a split when one pane is removed", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root);
    const split = splitPane(state, root.id, "vertical", createPaneRecord("session-b", "b"));

    const collapsed = closePane(split, root.id);

    expect(orderedPaneIds(collapsed.layout)).toEqual(["pane-session-b"]);
    expect(collapsed.focusedPaneId).toBe("pane-session-b");
  });

  it("updates split weights while preserving total size", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root);
    const split = splitPane(state, root.id, "horizontal", createPaneRecord("session-b", "b"));

    const resized = resizeSplit(split, [], 0, 0.45);

    expect(resized.layout).toMatchObject({
      type: "split",
      weights: [1.45, 0.55],
    });
  });

  it("clamps resize handles so panes cannot disappear", () => {
    expect(resizeSplitWeights([1, 1], 0, 10)).toEqual([1.8, 0.2]);
    expect(resizeSplitWeights([1, 1], 0, -10)).toEqual([0.2, 1.8]);
  });

  it("preserves ancestor weights when a nested split collapses", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root);
    const outer = splitPane(state, root.id, "horizontal", createPaneRecord("session-b", "b"));
    const resizedOuter = resizeSplit(outer, [], 0, 0.6);
    const nested = splitPane(
      resizedOuter,
      "pane-session-b",
      "vertical",
      createPaneRecord("session-c", "c"),
    );

    const collapsedNested = closePane(nested, "pane-session-c");

    expect(collapsedNested.layout).toMatchObject({
      type: "split",
      weights: [1.6, 0.4],
      children: [
        { type: "leaf", paneId: "pane-session-a" },
        { type: "leaf", paneId: "pane-session-b" },
      ],
    });
  });

  it("moves focus spatially instead of cycling ordered pane ids", () => {
    const root = createPaneRecord("session-a", "root");
    const initial = createWorkspace(root);
    const withBottom = splitPane(
      initial,
      root.id,
      "vertical",
      createPaneRecord("session-b", "bottom"),
    );
    const withTopRight = splitPane(
      withBottom,
      root.id,
      "horizontal",
      createPaneRecord("session-c", "top-right"),
    );

    const down = focusAdjacentPane({ ...withTopRight, focusedPaneId: root.id }, "down");
    const right = focusAdjacentPane({ ...withTopRight, focusedPaneId: root.id }, "right");

    expect(orderedPaneIds(withTopRight.layout)).toEqual([
      "pane-session-a",
      "pane-session-c",
      "pane-session-b",
    ]);
    expect(down.focusedPaneId).toBe("pane-session-b");
    expect(right.focusedPaneId).toBe("pane-session-c");
  });

  it("finds neighbors across nested splits using pane geometry", () => {
    const root = createPaneRecord("session-a", "root");
    const initial = createWorkspace(root);
    const withRight = splitPane(
      initial,
      root.id,
      "horizontal",
      createPaneRecord("session-b", "right"),
    );
    const nested = splitPane(
      withRight,
      "pane-session-b",
      "vertical",
      createPaneRecord("session-c", "bottom-right"),
    );

    expect(findAdjacentPaneId(nested.layout, "pane-session-c", "up")).toBe("pane-session-b");
    expect(findAdjacentPaneId(nested.layout, "pane-session-c", "left")).toBe("pane-session-a");
    expect(findAdjacentPaneId(nested.layout, "pane-session-a", "right")).toBe("pane-session-b");
    expect(findAdjacentPaneId(nested.layout, "pane-session-a", "left")).toBeNull();
  });
});
