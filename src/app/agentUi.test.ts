import { describe, expect, it } from "vitest";

import { emptyAgentSessionState, reduceAgentMessage, resolveApproval } from "./agentUi";

describe("agent ui reducer", () => {
  it("tracks lifecycle and tool updates", () => {
    let state = emptyAgentSessionState();

    state = reduceAgentMessage(state, {
      type: "Status",
      data: { phase: "reading", detail: "Inspecting files" },
    });
    state = reduceAgentMessage(state, {
      type: "ToolCall",
      data: { id: "tool-1", name: "read_file", args: { path: "src/App.tsx" } },
    });
    state = reduceAgentMessage(state, {
      type: "ToolResult",
      data: { id: "tool-1", result: { ok: true } },
    });

    expect(state.status?.phase).toBe("reading");
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]?.result).toEqual({ ok: true });
  });

  it("captures notifications and completion", () => {
    let state = emptyAgentSessionState();

    state = reduceAgentMessage(state, {
      type: "Notification",
      data: { level: "info", message: "Compiled successfully" },
    });
    state = reduceAgentMessage(state, {
      type: "Finished",
      data: { summary: "done", exit_code: 0 },
    });

    expect(state.notifications[0]?.message).toBe("Compiled successfully");
    expect(state.finished?.exitCode).toBe(0);
  });

  it("removes resolved approvals", () => {
    let state = emptyAgentSessionState();

    state = reduceAgentMessage(state, {
      type: "Approval",
      data: { id: "approval-1", message: "Delete files?", options: ["Allow", "Deny"] },
    });
    state = resolveApproval(state, "approval-1");

    expect(state.pendingApprovals).toHaveLength(0);
  });
});
