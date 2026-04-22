import { describe, expect, it, beforeEach } from "vitest";
import { usePeerStore } from "./peerStore";

describe("peerStore", () => {
  beforeEach(() => usePeerStore.getState().reset());

  it("appends post messages to the named channel", () => {
    const { ingestMessage } = usePeerStore.getState();
    ingestMessage({
      type: "peer_message",
      session_id: "s1",
      from: { kind: "agent", id: "claude" },
      to: { kind: "channel", id: "general" },
      kind: "post",
      channel: "general",
      correlation_id: null,
      body: { text: "hi" },
    });
    const messages = usePeerStore.getState().channelMessages.general;
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.from).toEqual({ kind: "agent", id: "claude" });
  });

  it("caps channel history", () => {
    const { ingestMessage } = usePeerStore.getState();
    for (let i = 0; i < 250; i++) {
      ingestMessage({
        type: "peer_message",
        session_id: "s1",
        from: { kind: "agent", id: "x" },
        to: { kind: "channel", id: "c" },
        kind: "post",
        channel: "c",
        correlation_id: null,
        body: i,
      });
    }
    expect(usePeerStore.getState().channelMessages.c).toHaveLength(200);
  });

  it("updates presence per session", () => {
    const { ingestPresence } = usePeerStore.getState();
    ingestPresence({
      type: "peer_presence",
      session_id: "s1",
      from: { kind: "session", id: "s1" },
      status: "thinking",
    });
    expect(usePeerStore.getState().presence.s1).toBe("thinking");
  });

  it("ignores dm events without a channel or user target", () => {
    const { ingestMessage } = usePeerStore.getState();
    ingestMessage({
      type: "peer_message",
      session_id: "s1",
      from: { kind: "agent", id: "x" },
      to: { kind: "session", id: "s2" },
      kind: "dm",
      channel: null,
      correlation_id: null,
      body: { text: "ignored" },
    });
    expect(Object.keys(usePeerStore.getState().channelMessages)).toHaveLength(0);
  });
});
