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
  it("captures pane cwd and serialized buffers for persistence", () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456);

    const root = createPaneRecord("session-a", "shell");
    const workspace = splitPane(
      createWorkspace(root),
      root.id,
      "vertical",
      createPaneRecord("session-b", "agent"),
    );
    const persisted = buildPersistedWorkspaceState(
      workspace,
      {
        "session-a": makeSessionInfo("session-a", "/tmp/a", "shell"),
        "session-b": makeSessionInfo("session-b", "/tmp/b", "agent"),
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
          layout: desktop.layout,
          focusedPaneId: desktop.focusedPaneId,
          maximizedPaneId: null,
        },
      ],
      panes: [
        { cwd: "/tmp/a", paneId: root.id, serializedBuffer: "A", title: "shell" },
        { cwd: "/tmp/b", paneId: "pane-session-b", serializedBuffer: "B", title: "agent" },
      ],
      savedAtMs: 123_456,
      version: 2,
    });
  });

  it("captures all desktops with panes flattened in a stable order", () => {
    vi.spyOn(Date, "now").mockReturnValue(111);

    const rootA = createPaneRecord("session-a", "a");
    let workspace = createWorkspace(rootA);
    workspace = createDesktop(workspace, createPaneRecord("session-b", "b"));
    workspace = splitPane(
      workspace,
      "pane-session-b",
      "horizontal",
      createPaneRecord("session-c", "c"),
    );

    const persisted = buildPersistedWorkspaceState(
      workspace,
      {
        "session-a": makeSessionInfo("session-a", "/a", "a"),
        "session-b": makeSessionInfo("session-b", "/b", "b"),
        "session-c": makeSessionInfo("session-c", "/c", "c"),
      },
      {},
    );

    expect(persisted?.desktops).toHaveLength(2);
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
          { cwd: "/tmp/a", paneId: "pane-a", serializedBuffer: "A", title: "shell" },
          { cwd: "/tmp/b", paneId: "pane-b", serializedBuffer: "B", title: "agent" },
        ],
        savedAtMs: 999,
        version: 2,
      },
      [makeSessionInfo("live-1", "/tmp/a", "shell"), makeSessionInfo("live-2", "/tmp/b", "agent")],
    );

    expect(restored?.workspace.activeDesktopId).toBe("desktop-1");
    expect(activeDesktop(restored!.workspace).focusedPaneId).toBe("pane-a");
    expect(restored?.workspace.panes["pane-a"]?.sessionId).toBe("live-1");
    expect(restored?.workspace.panes["pane-b"]?.sessionId).toBe("live-2");
    expect(restored?.restoredSnapshotsBySessionId["live-1"]?.serializedBuffer).toBe("A");
    expect(restored?.restoredSnapshotsBySessionId["live-2"]?.serializedBuffer).toBe("B");
  });

  it("migrates a v1 persisted payload into a single desktop", () => {
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
            { cwd: "/a", paneId: "pane-a", serializedBuffer: "A", title: "a" },
            { cwd: "/b", paneId: "pane-b", serializedBuffer: "B", title: "b" },
          ],
        });
      },
    };

    const persisted = readPersistedWorkspaceState(storage);

    expect(persisted?.version).toBe(2);
    expect(persisted?.desktops).toHaveLength(1);
    expect(persisted?.desktops[0]?.focusedPaneId).toBe("pane-a");
    expect(persisted?.desktops[0]?.layout).toMatchObject({ type: "split" });
    expect(persisted?.panes).toHaveLength(2);
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
