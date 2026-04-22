import { describe, expect, it } from "vitest";

import type { SessionInfo } from "../../lib/ipc";
import {
  buildSessionListRows,
  groupRowsByBranch,
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
          started_at_ms: 200,
        }),
      },
      { s1: "p1" },
    );
    expect(rows).toEqual<SessionListRow[]>([
      {
        sessionId: "s1",
        paneId: "p1",
        taskName: "fix the bell",
        agentId: "claude",
        worktreeBranchName: "feat-bell",
        startedAtMs: 200,
      },
    ]);
  });

  it("sorts newest first and marks missing pane as null", () => {
    const rows = buildSessionListRows(
      {
        old: info({ session_id: "old", started_at_ms: 100 }),
        new: info({ session_id: "new", started_at_ms: 300 }),
      },
      { new: "p1" },
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["new", "old"]);
    expect(rows[1]!.paneId).toBeNull();
  });

  it("falls back to cwd basename when worktree_path is absent", () => {
    const rows = buildSessionListRows(
      { s1: info({ session_id: "s1", cwd: "/home/me/project-x" }) },
      {},
    );
    expect(rows[0]!.worktreeBranchName).toBe("project-x");
  });
});

describe("groupRowsByBranch", () => {
  function row(
    overrides: Pick<SessionListRow, "sessionId" | "worktreeBranchName"> &
      Partial<SessionListRow>,
  ): SessionListRow {
    return {
      paneId: null,
      taskName: "t",
      agentId: "shell",
      startedAtMs: 0,
      ...overrides,
    };
  }

  it("preserves insertion order of branches and rows within", () => {
    const grouped = groupRowsByBranch([
      row({ sessionId: "a", worktreeBranchName: "main" }),
      row({ sessionId: "b", worktreeBranchName: "feat" }),
      row({ sessionId: "c", worktreeBranchName: "main" }),
    ]);
    expect(grouped.map((g) => g.branch)).toEqual(["main", "feat"]);
    expect(grouped[0]!.rows.map((r) => r.sessionId)).toEqual(["a", "c"]);
  });

  it("returns empty array for no rows", () => {
    expect(groupRowsByBranch([])).toEqual([]);
  });
});
