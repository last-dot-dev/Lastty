import { describe, expect, it, vi } from "vitest";

import { createPaneRecord, createWorkspace, splitPane } from "./layout";
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

    expect(persisted).toEqual({
      focusedPaneId: workspace.focusedPaneId,
      layout: workspace.layout,
      panes: [
        { cwd: "/tmp/a", paneId: root.id, serializedBuffer: "A", title: "shell" },
        { cwd: "/tmp/b", paneId: "pane-session-b", serializedBuffer: "B", title: "agent" },
      ],
      savedAtMs: 123_456,
      version: 1,
    });
  });

  it("rehydrates saved panes against newly created session ids", () => {
    const restored = buildRestoredWorkspaceState(
      {
        focusedPaneId: "pane-a",
        layout: {
          type: "split",
          direction: "vertical",
          children: [{ type: "leaf", paneId: "pane-a" }, { type: "leaf", paneId: "pane-b" }],
          weights: [1, 1],
        },
        panes: [
          { cwd: "/tmp/a", paneId: "pane-a", serializedBuffer: "A", title: "shell" },
          { cwd: "/tmp/b", paneId: "pane-b", serializedBuffer: "B", title: "agent" },
        ],
        savedAtMs: 999,
        version: 1,
      },
      [makeSessionInfo("live-1", "/tmp/a", "shell"), makeSessionInfo("live-2", "/tmp/b", "agent")],
    );

    expect(restored?.workspace.focusedPaneId).toBe("pane-a");
    expect(restored?.workspace.panes["pane-a"]?.sessionId).toBe("live-1");
    expect(restored?.workspace.panes["pane-b"]?.sessionId).toBe("live-2");
    expect(restored?.restoredSnapshotsBySessionId["live-1"]?.serializedBuffer).toBe("A");
    expect(restored?.restoredSnapshotsBySessionId["live-2"]?.serializedBuffer).toBe("B");
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
  };
}
