import { describe, expect, it, vi } from "vitest";

import {
  activeDesktop,
  createDesktop,
  createPaneRecord,
  createWorkspace,
  splitPane,
} from "./layout";
import {
  buildPersistedWorkspaceState,
  buildRestoredWorkspaceState,
  readPersistedWorkspaceState,
} from "./sessionRestore";
import type { SessionInfo } from "../lib/ipc";

describe("session restore helpers", () => {
  it("captures pane cwd, buffers, and desktop project root for persistence", () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456);

    const root = createPaneRecord("session-a", "shell");
    const workspace = splitPane(
      createWorkspace(root, "/proj/a"),
      root.id,
      "vertical",
      createPaneRecord("session-b", "agent"),
    );
    const persisted = buildPersistedWorkspaceState(
      workspace,
      {
        "session-a": makeSessionInfo("session-a", "/proj/a", "shell"),
        "session-b": makeSessionInfo("session-b", "/proj/a", "agent"),
      },
      {
        "session-a": { capturedAtMs: 1, cols: 80, rows: 24, serializedBuffer: "A" },
        "session-b": { capturedAtMs: 2, cols: 80, rows: 24, serializedBuffer: "B" },
      },
    );

    const desktop = activeDesktop(workspace);
    expect(persisted).toEqual({
      activeDesktopId: workspace.activeDesktopId,
      desktops: [
        {
          id: desktop.id,
          name: desktop.name,
          projectRoot: "/proj/a",
          layout: desktop.layout,
          focusedPaneId: desktop.focusedPaneId,
          maximizedPaneId: null,
        },
      ],
      panes: [
        { cwd: "/proj/a", paneId: root.id, serializedBuffer: "A", title: "shell" },
        { cwd: "/proj/a", paneId: "pane-session-b", serializedBuffer: "B", title: "agent" },
      ],
      savedAtMs: 123_456,
      version: 3,
    });
  });

  it("captures all desktops with panes flattened in a stable order", () => {
    vi.spyOn(Date, "now").mockReturnValue(111);

    const rootA = createPaneRecord("session-a", "a");
    let workspace = createWorkspace(rootA, "/proj/a");
    workspace = createDesktop(workspace, createPaneRecord("session-b", "b"), "/proj/b");
    workspace = splitPane(
      workspace,
      "pane-session-b",
      "horizontal",
      createPaneRecord("session-c", "c"),
    );

    const persisted = buildPersistedWorkspaceState(
      workspace,
      {
        "session-a": makeSessionInfo("session-a", "/proj/a", "a"),
        "session-b": makeSessionInfo("session-b", "/proj/b", "b"),
        "session-c": makeSessionInfo("session-c", "/proj/b", "c"),
      },
      {},
    );

    expect(persisted?.desktops).toHaveLength(2);
    expect(persisted?.desktops.map((desktop) => desktop.projectRoot)).toEqual([
      "/proj/a",
      "/proj/b",
    ]);
    expect(persisted?.panes.map((pane) => pane.paneId)).toEqual([
      "pane-session-a",
      "pane-session-b",
      "pane-session-c",
    ]);
  });

  it("rehydrates saved panes against newly created session ids", () => {
    const restored = buildRestoredWorkspaceState(
      {
        activeDesktopId: "desktop-1",
        desktops: [
          {
            id: "desktop-1",
            name: "Desktop 1",
            projectRoot: "/proj",
            layout: {
              type: "split",
              direction: "vertical",
              children: [
                { type: "leaf", paneId: "pane-a" },
                { type: "leaf", paneId: "pane-b" },
              ],
              weights: [1, 1],
            },
            focusedPaneId: "pane-a",
            maximizedPaneId: null,
          },
        ],
        panes: [
          { cwd: "/proj", paneId: "pane-a", serializedBuffer: "A", title: "shell" },
          { cwd: "/proj", paneId: "pane-b", serializedBuffer: "B", title: "agent" },
        ],
        savedAtMs: 999,
        version: 3,
      },
      [makeSessionInfo("live-1", "/proj", "shell"), makeSessionInfo("live-2", "/proj", "agent")],
    );

    expect(restored?.workspace.activeDesktopId).toBe("desktop-1");
    const desktop = activeDesktop(restored!.workspace);
    expect(desktop.focusedPaneId).toBe("pane-a");
    expect(desktop.projectRoot).toBe("/proj");
    expect(restored?.workspace.panes["pane-a"]?.sessionId).toBe("live-1");
    expect(restored?.workspace.panes["pane-b"]?.sessionId).toBe("live-2");
    expect(restored?.restoredSnapshotsBySessionId["live-1"]?.serializedBuffer).toBe("A");
    expect(restored?.restoredSnapshotsBySessionId["live-2"]?.serializedBuffer).toBe("B");
  });

  it("migrates a v1 payload through v2 into a v3 desktop with a project root", () => {
    const storage = {
      getItem() {
        return JSON.stringify({
          version: 1,
          savedAtMs: 50,
          focusedPaneId: "pane-a",
          layout: {
            type: "split",
            direction: "vertical",
            children: [
              { type: "leaf", paneId: "pane-a" },
              { type: "leaf", paneId: "pane-b" },
            ],
            weights: [1, 1],
          },
          panes: [
            { cwd: "/proj", paneId: "pane-a", serializedBuffer: "A", title: "a" },
            { cwd: "/proj", paneId: "pane-b", serializedBuffer: "B", title: "b" },
          ],
        });
      },
    };

    const persisted = readPersistedWorkspaceState(storage);

    expect(persisted?.version).toBe(3);
    expect(persisted?.desktops).toHaveLength(1);
    expect(persisted?.desktops[0]?.projectRoot).toBe("/proj");
    expect(persisted?.desktops[0]?.focusedPaneId).toBe("pane-a");
    expect(persisted?.panes).toHaveLength(2);
  });

  it("splits a v2 desktop whose panes live in different cwds into one view per cwd", () => {
    const storage = {
      getItem() {
        return JSON.stringify({
          version: 2,
          savedAtMs: 77,
          activeDesktopId: "desktop-1",
          desktops: [
            {
              id: "desktop-1",
              name: "View 1",
              layout: {
                type: "split",
                direction: "horizontal",
                children: [
                  { type: "leaf", paneId: "pane-a" },
                  { type: "leaf", paneId: "pane-b" },
                ],
                weights: [1, 1],
              },
              focusedPaneId: "pane-b",
              maximizedPaneId: null,
            },
          ],
          panes: [
            { cwd: "/proj/a", paneId: "pane-a", serializedBuffer: "A", title: "a" },
            { cwd: "/proj/b", paneId: "pane-b", serializedBuffer: "B", title: "b" },
          ],
        });
      },
    };

    const persisted = readPersistedWorkspaceState(storage);

    expect(persisted?.version).toBe(3);
    expect(persisted?.desktops).toHaveLength(2);
    expect(persisted?.desktops[0]?.projectRoot).toBe("/proj/a");
    expect(persisted?.desktops[0]?.layout).toEqual({ type: "leaf", paneId: "pane-a" });
    expect(persisted?.desktops[1]?.projectRoot).toBe("/proj/b");
    expect(persisted?.desktops[1]?.layout).toEqual({ type: "leaf", paneId: "pane-b" });
  });

  it("keeps a single view when all v2 panes share a cwd", () => {
    const storage = {
      getItem() {
        return JSON.stringify({
          version: 2,
          savedAtMs: 88,
          activeDesktopId: "desktop-1",
          desktops: [
            {
              id: "desktop-1",
              name: "View 1",
              layout: {
                type: "split",
                direction: "vertical",
                children: [
                  { type: "leaf", paneId: "pane-a" },
                  { type: "leaf", paneId: "pane-b" },
                ],
                weights: [1, 1],
              },
              focusedPaneId: "pane-a",
              maximizedPaneId: null,
            },
          ],
          panes: [
            { cwd: "/proj", paneId: "pane-a", serializedBuffer: "A", title: "a" },
            { cwd: "/proj", paneId: "pane-b", serializedBuffer: "B", title: "b" },
          ],
        });
      },
    };

    const persisted = readPersistedWorkspaceState(storage);

    expect(persisted?.version).toBe(3);
    expect(persisted?.desktops).toHaveLength(1);
    expect(persisted?.desktops[0]?.projectRoot).toBe("/proj");
    expect(persisted?.desktops[0]?.layout).toMatchObject({ type: "split" });
  });

  it("ignores malformed persisted payloads", () => {
    const storage = {
      getItem() {
        return "{";
      },
    };

    expect(readPersistedWorkspaceState(storage)).toBeNull();
  });
});

function makeSessionInfo(session_id: string, cwd: string, title: string): SessionInfo {
  return {
    session_id,
    title,
    agent_id: null,
    cwd,
    prompt: null,
    prompt_summary: null,
    worktree_path: null,
    control_connected: false,
    started_at_ms: 0,
    started_at_unix_ms: 0,
  };
}
