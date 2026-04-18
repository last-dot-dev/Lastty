import { describe, expect, it } from "vitest";

import { emptyAgentSessionState, type AgentSessionState } from "./agentUi";
import {
  BRANCH_COLOR_PALETTE,
  assignBranchColor,
  deriveAgentStatus,
  deriveAgentType,
  deriveBranchName,
  deriveProgressPct,
  deriveTaskName,
} from "./agentDerived";
import type { SessionInfo } from "../lib/ipc";

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: "s1",
    title: "shell",
    agent_id: null,
    cwd: "/tmp",
    prompt: null,
    prompt_summary: null,
    worktree_path: null,
    control_connected: false,
    started_at_ms: 0,
    started_at_unix_ms: 0,
    ...overrides,
  };
}

function stateWith(overrides: Partial<AgentSessionState>): AgentSessionState {
  return { ...emptyAgentSessionState(), ...overrides };
}

describe("deriveAgentStatus", () => {
  it("returns plan when no ui state and not exited", () => {
    expect(deriveAgentStatus(undefined, false)).toBe("plan");
  });

  it("returns done when session has exited even without ui state", () => {
    expect(deriveAgentStatus(undefined, true)).toBe("done");
  });

  it("returns needs_help when any pending approval exists", () => {
    const ui = stateWith({
      pendingApprovals: [{ id: "a", message: "?", options: [] }],
    });
    expect(deriveAgentStatus(ui, false)).toBe("needs_help");
  });

  it("needs_help wins over finished", () => {
    const ui = stateWith({
      pendingApprovals: [{ id: "a", message: "?", options: [] }],
      finished: { summary: "ok", exitCode: 0 },
    });
    expect(deriveAgentStatus(ui, true)).toBe("needs_help");
  });

  it("returns done when finished is set", () => {
    const ui = stateWith({ finished: { summary: "ok", exitCode: 0 } });
    expect(deriveAgentStatus(ui, false)).toBe("done");
  });

  it("returns plan otherwise", () => {
    expect(deriveAgentStatus(emptyAgentSessionState(), false)).toBe("plan");
  });
});

describe("deriveTaskName", () => {
  it("prefers prompt_summary", () => {
    expect(
      deriveTaskName(sessionInfo({ prompt_summary: "JWT auth", title: "claude" })),
    ).toBe("JWT auth");
  });

  it("falls back to title when prompt_summary is empty", () => {
    expect(deriveTaskName(sessionInfo({ prompt_summary: "  ", title: "claude" }))).toBe(
      "claude",
    );
  });

  it("returns 'shell' when nothing present", () => {
    expect(deriveTaskName(undefined)).toBe("shell");
    expect(deriveTaskName(sessionInfo({ title: "" }))).toBe("shell");
  });
});

describe("deriveBranchName", () => {
  it("returns last path segment of worktree_path", () => {
    expect(
      deriveBranchName(sessionInfo({ worktree_path: "/tmp/worktrees/feat-auth" })),
    ).toBe("feat-auth");
  });

  it("falls back to 'main' without worktree", () => {
    expect(deriveBranchName(sessionInfo())).toBe("main");
    expect(deriveBranchName(undefined)).toBe("main");
  });
});

describe("deriveAgentType", () => {
  it("returns agent_id when present", () => {
    expect(deriveAgentType(sessionInfo({ agent_id: "claude" }))).toBe("claude");
  });
  it("falls back to 'shell'", () => {
    expect(deriveAgentType(sessionInfo())).toBe("shell");
  });
});

describe("deriveProgressPct", () => {
  it("returns 0 when undefined", () => {
    expect(deriveProgressPct(undefined)).toBe(0);
  });
  it("returns 100 when finished with no progress", () => {
    const ui = stateWith({ finished: { summary: "", exitCode: 0 } });
    expect(deriveProgressPct(ui)).toBe(100);
  });
  it("clamps values to 0-100", () => {
    expect(
      deriveProgressPct(stateWith({ progress: { pct: 150, message: "" } })),
    ).toBe(100);
    expect(
      deriveProgressPct(stateWith({ progress: { pct: -10, message: "" } })),
    ).toBe(0);
  });
  it("rounds fractional values", () => {
    expect(
      deriveProgressPct(stateWith({ progress: { pct: 42.6, message: "" } })),
    ).toBe(43);
  });
});

describe("assignBranchColor", () => {
  it("assigns palette by index in order", () => {
    const order = ["a", "b", "c"];
    expect(assignBranchColor("a", order)).toBe(BRANCH_COLOR_PALETTE[0]);
    expect(assignBranchColor("b", order)).toBe(BRANCH_COLOR_PALETTE[1]);
    expect(assignBranchColor("c", order)).toBe(BRANCH_COLOR_PALETTE[2]);
  });

  it("wraps around the palette", () => {
    const order = Array.from({ length: BRANCH_COLOR_PALETTE.length + 2 }, (_, i) => `s${i}`);
    expect(assignBranchColor("s7", order)).toBe(BRANCH_COLOR_PALETTE[0]);
    expect(assignBranchColor("s8", order)).toBe(BRANCH_COLOR_PALETTE[1]);
  });

  it("stays stable when the same session appears in the same slot", () => {
    const order = ["a", "b", "c"];
    const first = assignBranchColor("b", order);
    const again = assignBranchColor("b", order);
    expect(first).toBe(again);
  });

  it("returns a palette color for unknown sessions via hashed fallback", () => {
    const color = assignBranchColor("unknown", []);
    expect(BRANCH_COLOR_PALETTE).toContain(color);
  });
});
