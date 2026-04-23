import { describe, expect, it } from "vitest";

import type { SessionInfo } from "../../lib/ipc";
import {
  buildSessionListRows,
  groupRowsByProject,
  type SessionListRow,
} from "./SessionList";

function info(overrides: Partial<SessionInfo> & Pick<SessionInfo, "session_id">): SessionInfo {
  return {
    title: "shell",
    agent_id: null,
    cwd: "/home/me/proj",
    prompt: null,
    prompt_summary: null,
    worktree_path: null,
    control_connected: false,
    started_at_ms: 0,
    started_at_unix_ms: 0,
    ...overrides,
  };
}

describe("buildSessionListRows", () => {
  it("maps sessions with pane lookup and derived fields", () => {
    const rows = buildSessionListRows(
      {
        s1: info({
          session_id: "s1",
          agent_id: "claude",
          prompt_summary: "fix the bell",
          worktree_path: "/repo/.lastty-worktrees/feat-bell",
          started_at_unix_ms: 1_700_000_000_200,
        }),
      },
      { s1: "p1" },
      { s1: "/repo" },
    );
    expect(rows).toEqual<SessionListRow[]>([
      {
        sessionId: "s1",
        paneId: "p1",
        taskName: "fix the bell",
        agentId: "claude",
        projectRoot: "/repo",
        projectLabel: "repo",
        startedAtUnixMs: 1_700_000_000_200,
      },
    ]);
  });

  it("sorts newest first and marks missing pane as null", () => {
    const rows = buildSessionListRows(
      {
        old: info({ session_id: "old", started_at_unix_ms: 100 }),
        new: info({ session_id: "new", started_at_unix_ms: 300 }),
      },
      { new: "p1" },
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["new", "old"]);
    expect(rows[1]!.paneId).toBeNull();
  });

  it("infers project root by stripping .lastty-worktrees suffix", () => {
    const rows = buildSessionListRows(
      {
        s1: info({
          session_id: "s1",
          worktree_path: "/Users/me/ws/lastty/.lastty-worktrees/feat-x",
        }),
      },
      {},
    );
    expect(rows[0]!.projectRoot).toBe("/Users/me/ws/lastty");
    expect(rows[0]!.projectLabel).toBe("lastty");
  });

  it("falls back to cwd when no worktree and no map entry", () => {
    const rows = buildSessionListRows(
      { s1: info({ session_id: "s1", cwd: "/home/me/project-x" }) },
      {},
    );
    expect(rows[0]!.projectRoot).toBe("/home/me/project-x");
    expect(rows[0]!.projectLabel).toBe("project-x");
  });

  it("shortens absolute-path task names to basename", () => {
    const rows = buildSessionListRows(
      {
        s1: info({
          session_id: "s1",
          title: "~/ws/lastty",
        }),
      },
      {},
      { s1: "/Users/me/ws/lastty" },
    );
    expect(rows[0]!.taskName).toBe("lastty");
  });

  it("strips project-root prefix from task name", () => {
    const rows = buildSessionListRows(
      {
        s1: info({
          session_id: "s1",
          title: "/Users/me/ws/lastty/src/main.rs",
        }),
      },
      {},
      { s1: "/Users/me/ws/lastty" },
    );
    expect(rows[0]!.taskName).toBe("src/main.rs");
  });
});

describe("groupRowsByProject", () => {
  function row(
    overrides: Pick<SessionListRow, "sessionId" | "projectRoot"> &
      Partial<SessionListRow>,
  ): SessionListRow {
    return {
      paneId: null,
      taskName: "t",
      agentId: "shell",
      projectLabel: overrides.projectRoot.split("/").filter(Boolean).pop() ?? "",
      startedAtUnixMs: 0,
      ...overrides,
    };
  }

  it("preserves insertion order of projects and rows within", () => {
    const grouped = groupRowsByProject([
      row({ sessionId: "a", projectRoot: "/repo/alpha" }),
      row({ sessionId: "b", projectRoot: "/repo/beta" }),
      row({ sessionId: "c", projectRoot: "/repo/alpha" }),
    ]);
    expect(grouped.map((g) => g.projectRoot)).toEqual([
      "/repo/alpha",
      "/repo/beta",
    ]);
    expect(grouped[0]!.rows.map((r) => r.sessionId)).toEqual(["a", "c"]);
    expect(grouped[0]!.projectLabel).toBe("alpha");
  });

  it("returns empty array for no rows", () => {
    expect(groupRowsByProject([])).toEqual([]);
  });
});
