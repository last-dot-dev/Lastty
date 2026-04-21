import { describe, expect, it } from "vitest";

import {
  emptyAgentSessionState,
  latestToolCall,
  reduceAgentMessage,
  resolveApproval,
  toolCallCount,
} from "./agentUi";

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
    expect(state.toolCallOrder).toEqual(["tool-1"]);
    expect(state.rootToolCallIds).toEqual(["tool-1"]);
    expect(state.toolCallsById["tool-1"]?.result).toEqual({ ok: true });
    expect(state.toolCallsById["tool-1"]?.depth).toBe(0);
    expect(latestToolCall(state)?.id).toBe("tool-1");
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
    state = reduceAgentMessage(state, {
      type: "ApprovalResolved",
      data: { id: "approval-1" },
    });

    expect(state.pendingApprovals).toHaveLength(0);
  });

  it("nests subagent tool calls under their parent", () => {
    let state = emptyAgentSessionState();

    state = reduceAgentMessage(state, {
      type: "ToolCall",
      data: { id: "task-1", name: "Agent", args: { subagent_type: "general" } },
    });
    state = reduceAgentMessage(state, {
      type: "ToolCall",
      data: {
        id: "grep-1",
        name: "Grep",
        args: { pattern: "TODO" },
        parent_id: "task-1",
      },
    });
    state = reduceAgentMessage(state, {
      type: "ToolCall",
      data: {
        id: "read-1",
        name: "Read",
        args: { file_path: "a.rs" },
        parent_id: "task-1",
      },
    });
    state = reduceAgentMessage(state, {
      type: "ToolResult",
      data: { id: "grep-1", result: ["match"], parent_id: "task-1" },
    });

    expect(state.rootToolCallIds).toEqual(["task-1"]);
    expect(state.childrenByParentId["task-1"]).toEqual(["grep-1", "read-1"]);
    expect(state.toolCallsById["grep-1"]?.parentId).toBe("task-1");
    expect(state.toolCallsById["grep-1"]?.depth).toBe(1);
    expect(state.toolCallsById["grep-1"]?.result).toEqual(["match"]);

    const counts = toolCallCount(state);
    expect(counts.root).toBe(1);
    expect(counts.sub).toBe(2);
    expect(counts.total).toBe(3);
  });

  it("does not cap tool calls at 50", () => {
    let state = emptyAgentSessionState();

    for (let i = 0; i < 100; i += 1) {
      state = reduceAgentMessage(state, {
        type: "ToolCall",
        data: { id: `t-${i}`, name: "Bash", args: { cmd: `echo ${i}` } },
      });
    }

    expect(state.toolCallOrder).toHaveLength(100);
    expect(state.rootToolCallIds).toHaveLength(100);
    expect(state.toolCallsById["t-0"]).toBeDefined();
    expect(state.toolCallsById["t-99"]).toBeDefined();
  });

  it("ignores ToolResult for unknown ids", () => {
    let state = emptyAgentSessionState();
    state = reduceAgentMessage(state, {
      type: "ToolResult",
      data: { id: "ghost", result: 42 },
    });
    expect(state.toolCallOrder).toEqual([]);
    expect(state.toolCallsById).toEqual({});
  });
});
