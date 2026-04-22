import { describe, expect, it, beforeEach } from "vitest";
import { useAgentStore } from "./agentStore";

describe("agentStore", () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
  });

  it("routes messages per session", () => {
    const { ingest } = useAgentStore.getState();
    ingest("a", { type: "Status", data: { phase: "thinking" } });
    ingest("b", { type: "Status", data: { phase: "waiting" } });

    const { sessions } = useAgentStore.getState();
    expect(sessions.a?.status?.phase).toBe("thinking");
    expect(sessions.b?.status?.phase).toBe("waiting");
  });

  it("resolves approvals without touching other sessions", () => {
    const { ingest, resolveApproval } = useAgentStore.getState();
    ingest("a", {
      type: "Approval",
      data: { id: "1", message: "ok?", options: ["yes", "no"] },
    });
    ingest("b", {
      type: "Approval",
      data: { id: "2", message: "still?", options: ["yes"] },
    });

    resolveApproval("a", "1");

    const { sessions } = useAgentStore.getState();
    expect(sessions.a?.pendingApprovals).toHaveLength(0);
    expect(sessions.b?.pendingApprovals).toHaveLength(1);
  });

  it("forgets a session", () => {
    const { ingest, forgetSession } = useAgentStore.getState();
    ingest("a", { type: "Status", data: { phase: "thinking" } });
    forgetSession("a");
    expect(useAgentStore.getState().sessions.a).toBeUndefined();
  });

  it("accumulates notifications and resolves approval is a no-op on unknown session", () => {
    const { ingest, resolveApproval } = useAgentStore.getState();
    ingest("a", {
      type: "Notification",
      data: { level: "info", message: "hi" },
    });
    resolveApproval("missing", "x");
    expect(useAgentStore.getState().sessions.a?.notifications).toHaveLength(1);
    expect(useAgentStore.getState().sessions.missing).toBeUndefined();
  });
});
