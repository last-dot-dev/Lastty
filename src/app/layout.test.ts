import { describe, expect, it } from "vitest";

import {
  activeDesktop,
  attachPaneToDesktop,
  closeDesktop,
  closePane,
  createDesktop,
  createPaneRecord,
  createWorkspace,
  detachPane,
  findAdjacentPaneId,
  findDesktopForPane,
  focusAdjacentPane,
  focusPane,
  nextDesktopIdInDirection,
  orderedPaneIds,
  renameDesktop,
  resizeSplit,
  resizeSplitWeights,
  splitAtPane,
  splitPane,
  swapPanes,
  switchDesktop,
  toggleMaximize,
} from "./layout";

describe("layout state", () => {
  it("boots with a single desktop containing the root pane", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root, "/proj");

    expect(state.desktops).toHaveLength(1);
    const desktop = activeDesktop(state);
    expect(desktop.name).toBe("View 1");
    expect(desktop.focusedPaneId).toBe(root.id);
    expect(desktop.maximizedPaneId).toBeNull();
    expect(state.panes[root.id]).toEqual(root);
  });

  it("splits the focused pane into a two-child layout", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root, "/proj");

    const next = createPaneRecord("session-b", "secondary");
    const updated = splitPane(state, root.id, "horizontal", next);

    const desktop = activeDesktop(updated);
    expect(desktop.focusedPaneId).toBe(next.id);
    expect(desktop.layout && orderedPaneIds(desktop.layout)).toEqual([root.id, next.id]);
  });

  it("returns the same reference when focusing a pane that is already focused", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root, "/proj");

    expect(focusPane(state, root.id)).toBe(state);
  });

  it("produces a new reference when focus actually moves", () => {
    const root = createPaneRecord("session-a", "root");
    const next = createPaneRecord("session-b", "secondary");
    const state = splitPane(createWorkspace(root, "/proj"), root.id, "horizontal", next);

    const refocused = focusPane(state, root.id);
    expect(refocused).not.toBe(state);
    expect(activeDesktop(refocused).focusedPaneId).toBe(root.id);
  });

  it("collapses a split when one pane is removed", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root, "/proj");
    const split = splitPane(state, root.id, "vertical", createPaneRecord("session-b", "b"));

    const collapsed = closePane(split, root.id);
    const desktop = activeDesktop(collapsed);

    expect(desktop.layout && orderedPaneIds(desktop.layout)).toEqual(["pane-session-b"]);
    expect(desktop.focusedPaneId).toBe("pane-session-b");
  });

  it("allows closing the last pane of a desktop, leaving it empty", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root, "/proj");

    const empty = closePane(state, root.id);
    const desktop = activeDesktop(empty);

    expect(desktop.layout).toBeNull();
    expect(desktop.focusedPaneId).toBeNull();
    expect(empty.panes[root.id]).toBeUndefined();
  });

  it("updates split weights while preserving total size", () => {
    const root = createPaneRecord("session-a", "root");
    const state = createWorkspace(root, "/proj");
    const split = splitPane(state, root.id, "horizontal", createPaneRecord("session-b", "b"));

    const resized = resizeSplit(split, [], 0, 0.45);
    const desktop = activeDesktop(resized);

    expect(desktop.layout).toMatchObject({
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
    const state = createWorkspace(root, "/proj");
    const outer = splitPane(state, root.id, "horizontal", createPaneRecord("session-b", "b"));
    const resizedOuter = resizeSplit(outer, [], 0, 0.6);
    const nested = splitPane(
      resizedOuter,
      "pane-session-b",
      "vertical",
      createPaneRecord("session-c", "c"),
    );

    const collapsedNested = closePane(nested, "pane-session-c");
    const desktop = activeDesktop(collapsedNested);

    expect(desktop.layout).toMatchObject({
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
    const initial = createWorkspace(root, "/proj");
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

    const withRootFocused = {
      ...withTopRight,
      desktops: withTopRight.desktops.map((desktop) =>
        desktop.id === withTopRight.activeDesktopId
          ? { ...desktop, focusedPaneId: root.id }
          : desktop,
      ),
    };

    const down = focusAdjacentPane(withRootFocused, "down");
    const right = focusAdjacentPane(withRootFocused, "right");

    const desktopLayout = activeDesktop(withTopRight).layout!;
    expect(orderedPaneIds(desktopLayout)).toEqual([
      "pane-session-a",
      "pane-session-c",
      "pane-session-b",
    ]);
    expect(activeDesktop(down).focusedPaneId).toBe("pane-session-b");
    expect(activeDesktop(right).focusedPaneId).toBe("pane-session-c");
  });

  it("finds neighbors across nested splits using pane geometry", () => {
    const root = createPaneRecord("session-a", "root");
    const initial = createWorkspace(root, "/proj");
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
    const layout = activeDesktop(nested).layout!;

    expect(findAdjacentPaneId(layout, "pane-session-c", "up")).toBe("pane-session-b");
    expect(findAdjacentPaneId(layout, "pane-session-c", "left")).toBe("pane-session-a");
    expect(findAdjacentPaneId(layout, "pane-session-a", "right")).toBe("pane-session-b");
    expect(findAdjacentPaneId(layout, "pane-session-a", "left")).toBeNull();
  });
});

describe("desktop management", () => {
  it("creates a new desktop and switches to it", () => {
    const rootA = createPaneRecord("session-a");
    const state = createWorkspace(rootA, "/proj");

    const rootB = createPaneRecord("session-b");
    const withSecond = createDesktop(state, rootB, "/proj");

    expect(withSecond.desktops).toHaveLength(2);
    expect(withSecond.activeDesktopId).toBe(withSecond.desktops[1]!.id);
    expect(withSecond.desktops[1]!.name).toBe("View 2");
    expect(activeDesktop(withSecond).focusedPaneId).toBe(rootB.id);
    expect(withSecond.panes[rootA.id]).toBeDefined();
    expect(withSecond.panes[rootB.id]).toBeDefined();
  });

  it("closeDesktop removes its panes and returns their session ids", () => {
    const rootA = createPaneRecord("session-a");
    const state = createWorkspace(rootA, "/proj");
    const rootB = createPaneRecord("session-b");
    const withSecond = createDesktop(state, rootB, "/proj");
    const secondId = withSecond.activeDesktopId;
    const withSplit = splitPane(
      withSecond,
      rootB.id,
      "vertical",
      createPaneRecord("session-c"),
    );

    const { workspace, removedSessionIds } = closeDesktop(withSplit, secondId);

    expect(workspace.desktops).toHaveLength(1);
    expect(workspace.activeDesktopId).toBe(workspace.desktops[0]!.id);
    expect(removedSessionIds).toEqual(expect.arrayContaining(["session-b", "session-c"]));
    expect(workspace.panes[rootB.id]).toBeUndefined();
    expect(workspace.panes["pane-session-c"]).toBeUndefined();
    expect(workspace.panes[rootA.id]).toBeDefined();
  });

  it("closeDesktop refuses to close the last remaining desktop", () => {
    const root = createPaneRecord("session-a");
    const state = createWorkspace(root, "/proj");

    const { workspace, removedSessionIds } = closeDesktop(state, state.activeDesktopId);

    expect(workspace).toBe(state);
    expect(removedSessionIds).toEqual([]);
  });

  it("switchDesktop activates the target desktop without mutating panes", () => {
    const root = createPaneRecord("session-a");
    const state = createWorkspace(root, "/proj");
    const firstId = state.activeDesktopId;
    const withSecond = createDesktop(state, createPaneRecord("session-b"), "/proj");

    const back = switchDesktop(withSecond, firstId);

    expect(back.activeDesktopId).toBe(firstId);
    expect(back.desktops).toBe(withSecond.desktops);
  });

  it("renameDesktop trims whitespace and preserves names on empty input", () => {
    const state = createWorkspace(createPaneRecord("session-a"), "/proj");
    const renamed = renameDesktop(state, state.activeDesktopId, "  Build  ");
    expect(activeDesktop(renamed).name).toBe("Build");

    const unchanged = renameDesktop(renamed, renamed.activeDesktopId, "   ");
    expect(unchanged).toBe(renamed);
  });

  it("nextDesktopIdInDirection wraps around", () => {
    let state = createWorkspace(createPaneRecord("session-a"), "/proj");
    state = createDesktop(state, createPaneRecord("session-b"), "/proj");
    state = createDesktop(state, createPaneRecord("session-c"), "/proj");
    const [, , third] = state.desktops;
    state = switchDesktop(state, state.desktops[0]!.id);

    expect(nextDesktopIdInDirection(state, 1)).toBe(state.desktops[1]!.id);
    expect(nextDesktopIdInDirection(state, -1)).toBe(third!.id);
  });

  it("toggleMaximize flips a pane's maximized state within its desktop", () => {
    const root = createPaneRecord("session-a");
    const state = createWorkspace(root, "/proj");
    const split = splitPane(state, root.id, "horizontal", createPaneRecord("session-b"));

    const maxed = toggleMaximize(split, root.id);
    expect(activeDesktop(maxed).maximizedPaneId).toBe(root.id);

    const restored = toggleMaximize(maxed, root.id);
    expect(activeDesktop(restored).maximizedPaneId).toBeNull();
  });

  it("findDesktopForPane locates a pane across desktops", () => {
    const state = createWorkspace(createPaneRecord("session-a"), "/proj");
    const firstDesktopId = state.activeDesktopId;
    const withSecond = createDesktop(state, createPaneRecord("session-b"), "/proj");

    expect(findDesktopForPane(withSecond, "pane-session-a")?.id).toBe(firstDesktopId);
    expect(findDesktopForPane(withSecond, "pane-session-b")?.id).toBe(withSecond.activeDesktopId);
    expect(findDesktopForPane(withSecond, "pane-missing")).toBeNull();
  });
});

describe("drag-and-drop layout helpers", () => {
  it("detachPane removes a leaf and collapses singleton splits, keeping the pane in the global map", () => {
    const root = createPaneRecord("session-a");
    const state = splitPane(
      createWorkspace(root, "/proj"),
      root.id,
      "horizontal",
      createPaneRecord("session-b"),
    );

    const detached = detachPane(state, "pane-session-b");
    const desktop = activeDesktop(detached);

    expect(desktop.layout).toEqual({ type: "leaf", paneId: root.id });
    expect(detached.panes["pane-session-b"]).toBeDefined();
    expect(desktop.focusedPaneId).toBe(root.id);
  });

  it("attachPaneToDesktop wraps an existing layout with the incoming pane on the right", () => {
    let state = createWorkspace(createPaneRecord("session-a"), "/proj");
    state = createDesktop(state, createPaneRecord("session-b"), "/proj");
    const firstDesktopId = state.desktops[0]!.id;

    const detached = detachPane(state, "pane-session-b");
    const attached = attachPaneToDesktop(detached, "pane-session-b", firstDesktopId);
    const desktop = attached.desktops.find((entry) => entry.id === firstDesktopId)!;

    expect(desktop.layout).toMatchObject({
      type: "split",
      direction: "horizontal",
      children: [
        { type: "leaf", paneId: "pane-session-a" },
        { type: "leaf", paneId: "pane-session-b" },
      ],
    });
    expect(desktop.focusedPaneId).toBe("pane-session-b");
  });

  it("attachPaneToDesktop fills an empty desktop with a single leaf", () => {
    let state = createWorkspace(createPaneRecord("session-a"), "/proj");
    state = createDesktop(state, createPaneRecord("session-b"), "/proj");
    const secondDesktopId = state.activeDesktopId;
    const emptied = detachPane(state, "pane-session-b");
    const emptyDesktop = emptied.desktops.find((entry) => entry.id === secondDesktopId)!;
    expect(emptyDesktop.layout).toBeNull();

    const attached = attachPaneToDesktop(emptied, "pane-session-a", secondDesktopId);
    const desktop = attached.desktops.find((entry) => entry.id === secondDesktopId)!;
    expect(desktop.layout).toEqual({ type: "leaf", paneId: "pane-session-a" });
  });

  it("splitAtPane places the source leaf beside the target in the requested direction", () => {
    let state = createWorkspace(createPaneRecord("session-a"), "/proj");
    state = createDesktop(state, createPaneRecord("session-b"), "/proj");
    const firstDesktopId = state.desktops[0]!.id;

    const after = splitAtPane(state, "pane-session-a", "pane-session-b", "right");
    const firstDesktop = after.desktops.find((entry) => entry.id === firstDesktopId)!;

    expect(firstDesktop.layout).toMatchObject({
      type: "split",
      direction: "horizontal",
      children: [
        { type: "leaf", paneId: "pane-session-a" },
        { type: "leaf", paneId: "pane-session-b" },
      ],
    });
    const secondDesktop = after.desktops.find((entry) => entry.id !== firstDesktopId)!;
    expect(secondDesktop.layout).toBeNull();
  });

  it("splitAtPane is a no-op when source and target are the same", () => {
    const state = splitPane(
      createWorkspace(createPaneRecord("session-a"), "/proj"),
      "pane-session-a",
      "horizontal",
      createPaneRecord("session-b"),
    );

    const after = splitAtPane(state, "pane-session-a", "pane-session-a", "top");
    expect(after).toBe(state);
  });

  it("swapPanes swaps two leaves across desktops without mutating the panes map", () => {
    let state = createWorkspace(createPaneRecord("session-a"), "/proj");
    state = createDesktop(state, createPaneRecord("session-b"), "/proj");

    const swapped = swapPanes(state, "pane-session-a", "pane-session-b");
    const [first, second] = swapped.desktops;

    expect(first!.layout).toEqual({ type: "leaf", paneId: "pane-session-b" });
    expect(second!.layout).toEqual({ type: "leaf", paneId: "pane-session-a" });
    expect(Object.keys(swapped.panes).sort()).toEqual(
      Object.keys(state.panes).sort(),
    );
  });

  it("swapPanes works within a single desktop's nested layout", () => {
    let state = createWorkspace(createPaneRecord("session-a"), "/proj");
    state = splitPane(state, "pane-session-a", "horizontal", createPaneRecord("session-b"));
    state = splitPane(state, "pane-session-b", "vertical", createPaneRecord("session-c"));

    const swapped = swapPanes(state, "pane-session-a", "pane-session-c");
    const ordered = orderedPaneIds(activeDesktop(swapped).layout!);

    expect(ordered).toEqual([
      "pane-session-c",
      "pane-session-b",
      "pane-session-a",
    ]);
  });
});
