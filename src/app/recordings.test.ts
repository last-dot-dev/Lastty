import { describe, expect, it } from "vitest";

import { buildRecordingReplayModel, formatBytes } from "./recordings";

describe("recording replay model", () => {
  it("summarizes session activity and byte totals", () => {
    const model = buildRecordingReplayModel(sampleRecording());

    expect(model.stats.totalEvents).toBe(9);
    expect(model.stats.ptyOutputs).toBe(2);
    expect(model.stats.ptyInputs).toBe(1);
    expect(model.stats.agentEvents).toBe(3);
    expect(model.stats.approvalRequests).toBe(0);
    expect(model.stats.approvalResolutions).toBe(1);
    expect(model.stats.resizeEvents).toBe(1);
    expect(model.stats.outputBytes).toBe(11);
    expect(model.stats.inputBytes).toBe(4);
    expect(model.stats.durationMs).toBe(700);
  });

  it("builds a compact semantic timeline with grouped terminal activity", () => {
    const model = buildRecordingReplayModel(sampleRecording());

    expect(model.timeline.map((entry) => entry.title)).toEqual([
      "Session created",
      "Terminal output",
      "Agent status · reading",
      "Terminal output",
      "Tool call · read_file",
      "Approval resolved",
      "Viewport resized",
      "Terminal input",
      "Agent finished",
    ]);
    expect(model.timeline[1]?.detail).toBe("1 chunk · 5 B");
    expect(model.timeline[3]?.detail).toBe("1 chunk · 6 B");
  });

  it("captures per-step semantic replay state for scrubbing", () => {
    const model = buildRecordingReplayModel(sampleRecordedAgentMessages());

    expect(model.playbackSteps.map((entry) => entry.title)).toEqual([
      "Session created",
      "Agent status · thinking",
      "Approval requested",
      "Approval resolved",
      "Agent finished",
    ]);
    expect(model.playbackSteps[1]?.agentState.status?.phase).toBe("thinking");
    expect(model.playbackSteps[2]?.agentState.pendingApprovals).toHaveLength(1);
    expect(model.playbackSteps[3]?.agentState.pendingApprovals).toHaveLength(0);
    expect(model.playbackSteps[4]?.agentState.finished?.summary).toBe("done");
  });

  it("formats byte counts for replay stats", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2.0 KB");
  });
});

function sampleRecording() {
  return [
    '{"ts_ms":1000,"event":{"type":"session_created","session_id":"abc","agent_id":"codex"}}',
    '{"ts_ms":1050,"event":{"type":"pty_output","session_id":"abc","bytes":[104,101,108,108,111]}}',
    '{"ts_ms":1100,"event":{"type":"agent_status","session_id":"abc","phase":"reading","detail":"Inspecting src"}}',
    '{"ts_ms":1200,"event":{"type":"pty_output","session_id":"abc","bytes":[32,119,111,114,108,100]}}',
    '{"ts_ms":1300,"event":{"type":"agent_tool_call","session_id":"abc","tool":"read_file","args":{"path":"src/main.ts"}}}',
    '{"ts_ms":1400,"event":{"type":"user_approval","session_id":"abc","approval_id":"approve-1","choice":"Allow"}}',
    '{"ts_ms":1500,"event":{"type":"resize","session_id":"abc","cols":120,"rows":40}}',
    '{"ts_ms":1600,"event":{"type":"pty_input","session_id":"abc","bytes":[101,120,105,116]}}',
    '{"ts_ms":1700,"event":{"type":"agent_finished","session_id":"abc","summary":"done","exit_code":0}}',
  ].join("\n");
}

function sampleRecordedAgentMessages() {
  return [
    '{"ts_ms":1000,"event":{"type":"session_created","session_id":"abc","agent_id":"codex"}}',
    '{"ts_ms":1100,"agent_ui_message":{"type":"Status","data":{"phase":"thinking","detail":"Inspecting repo"}}}',
    '{"ts_ms":1200,"agent_ui_message":{"type":"Approval","data":{"id":"approve-1","message":"Allow write?","options":["Allow","Deny"]}}}',
    '{"ts_ms":1300,"event":{"type":"user_approval","session_id":"abc","approval_id":"approve-1","choice":"Allow"}}',
    '{"ts_ms":1400,"agent_ui_message":{"type":"Finished","data":{"summary":"done","exit_code":0}}}',
  ].join("\n");
}
