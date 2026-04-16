import {
  emptyAgentSessionState,
  parseAgentMessage,
  reduceAgentMessage,
  resolveApproval,
  type AgentSessionState,
  type AgentUiMessage,
} from "./agentUi";
import type { BusEvent } from "../lib/ipc";

export interface RecordingLine {
  ts_ms?: number;
  event?: BusEvent;
  agent_ui_message?: AgentUiMessage;
}

export interface RecordingStats {
  totalEvents: number;
  ptyOutputs: number;
  ptyInputs: number;
  agentEvents: number;
  approvalRequests: number;
  approvalResolutions: number;
  notifications: number;
  widgets: number;
  resizeEvents: number;
  outputBytes: number;
  inputBytes: number;
  durationMs: number;
}

export interface TimelineEntry {
  tsMs: number | null;
  kind: "lifecycle" | "agent" | "approval" | "terminal" | "resize";
  title: string;
  detail: string;
  tone: "neutral" | "success" | "warning";
}

export interface ReplayStep extends TimelineEntry {
  lineIndex: number;
  eventCount: number;
  outputBytes: number;
  inputBytes: number;
  agentState: AgentSessionState;
}

export interface RecordingReplayModel {
  lines: RecordingLine[];
  stats: RecordingStats;
  timeline: TimelineEntry[];
  playbackSteps: ReplayStep[];
  agentState: AgentSessionState;
  hasRecordedAgentMessages: boolean;
}

export function buildRecordingReplayModel(contents: string): RecordingReplayModel {
  const lines = parseRecording(contents);
  const hasRecordedAgentMessages = recordingHasAgentMessages(lines);
  const playbackSteps = buildReplaySteps(lines, hasRecordedAgentMessages);
  return {
    lines,
    stats: summarizeRecording(lines, hasRecordedAgentMessages),
    timeline: playbackSteps.map(({ lineIndex: _lineIndex, eventCount: _eventCount, outputBytes: _outputBytes, inputBytes: _inputBytes, agentState: _agentState, ...entry }) => entry),
    playbackSteps,
    agentState:
      playbackSteps[playbackSteps.length - 1]?.agentState ??
      buildAgentState(lines, hasRecordedAgentMessages),
    hasRecordedAgentMessages,
  };
}

export function parseRecording(contents: string): RecordingLine[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as RecordingLine;
        const agentUiMessage = parseAgentMessage(parsed.agent_ui_message);
        return {
          ...parsed,
          agent_ui_message: agentUiMessage ?? undefined,
        };
      } catch {
        return {};
      }
    });
}

export function summarizeRecording(
  lines: RecordingLine[],
  hasRecordedAgentMessages = recordingHasAgentMessages(lines),
): RecordingStats {
  const typedEvents = lines.flatMap((line) => (line.event ? [line.event] : []));
  const agentMessages = lines.flatMap((line) =>
    line.agent_ui_message ? [line.agent_ui_message] : [],
  );
  const outputEvents = typedEvents.filter((event) => event.type === "pty_output");
  const inputEvents = typedEvents.filter((event) => event.type === "pty_input");

  const startTs = lines.find((line) => typeof line.ts_ms === "number")?.ts_ms ?? 0;
  const endTs =
    [...lines].reverse().find((line) => typeof line.ts_ms === "number")?.ts_ms ?? startTs;

  return {
    totalEvents: typedEvents.length + agentMessages.length,
    ptyOutputs: outputEvents.length,
    ptyInputs: inputEvents.length,
    agentEvents: hasRecordedAgentMessages
      ? agentMessages.length
      : typedEvents.filter((event) => event.type.startsWith("agent_")).length,
    approvalRequests: agentMessages.filter((message) => message.type === "Approval").length,
    approvalResolutions: typedEvents.filter((event) => event.type === "user_approval").length,
    notifications: agentMessages.filter((message) => message.type === "Notification").length,
    widgets: agentMessages.filter((message) => message.type === "Widget").length,
    resizeEvents: typedEvents.filter((event) => event.type === "resize").length,
    outputBytes: sumBytes(outputEvents),
    inputBytes: sumBytes(inputEvents),
    durationMs: Math.max(0, endTs - startTs),
  };
}

export function buildSemanticTimeline(
  lines: RecordingLine[],
  hasRecordedAgentMessages = recordingHasAgentMessages(lines),
): TimelineEntry[] {
  return buildReplaySteps(lines, hasRecordedAgentMessages).map(
    ({ lineIndex: _lineIndex, eventCount: _eventCount, outputBytes: _outputBytes, inputBytes: _inputBytes, agentState: _agentState, ...entry }) => entry,
  );
}

export function buildReplaySteps(
  lines: RecordingLine[],
  hasRecordedAgentMessages = recordingHasAgentMessages(lines),
): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let agentState = emptyAgentSessionState();
  let pendingTerminal:
    | {
        direction: "input" | "output";
        chunks: number;
        bytes: number;
        lastTs: number | null;
        lineIndex: number;
      }
    | null = null;

  const pushStep = (
    entry: TimelineEntry,
    lineIndex: number,
    eventCount: number,
    outputBytes = 0,
    inputBytes = 0,
  ) => {
    steps.push({
      ...entry,
      lineIndex,
      eventCount,
      outputBytes,
      inputBytes,
      agentState,
    });
  };

  const flushTerminal = () => {
    if (!pendingTerminal) return;
    pushStep(
      {
        tsMs: pendingTerminal.lastTs,
        kind: "terminal",
        title: pendingTerminal.direction === "output" ? "Terminal output" : "Terminal input",
        detail: `${pendingTerminal.chunks} chunk${pendingTerminal.chunks === 1 ? "" : "s"} · ${formatBytes(
          pendingTerminal.bytes,
        )}`,
        tone: "neutral",
      },
      pendingTerminal.lineIndex,
      pendingTerminal.chunks,
      pendingTerminal.direction === "output" ? pendingTerminal.bytes : 0,
      pendingTerminal.direction === "input" ? pendingTerminal.bytes : 0,
    );
    pendingTerminal = null;
  };

  lines.forEach((line, lineIndex) => {
    const { event, agent_ui_message: message } = line;

    if (event && (event.type === "pty_input" || event.type === "pty_output")) {
      const direction = event.type === "pty_output" ? "output" : "input";
      const bytes = event.bytes.length;
      if (pendingTerminal && pendingTerminal.direction === direction) {
        pendingTerminal.chunks += 1;
        pendingTerminal.bytes += bytes;
        pendingTerminal.lastTs = line.ts_ms ?? pendingTerminal.lastTs;
        pendingTerminal.lineIndex = lineIndex;
      } else {
        flushTerminal();
        pendingTerminal = {
          direction,
          chunks: 1,
          bytes,
          lastTs: line.ts_ms ?? null,
          lineIndex,
        };
      }
      return;
    }

    if (message) {
      flushTerminal();
      agentState = reduceAgentMessage(agentState, message, line.ts_ms ?? 0);
      pushStep(mapAgentMessageToTimelineEntry(line.ts_ms ?? null, message), lineIndex, 1);
      return;
    }

    if (!event || shouldSkipEventInTimeline(event, hasRecordedAgentMessages)) {
      return;
    }

    flushTerminal();

    if (!hasRecordedAgentMessages) {
      const syntheticMessage = agentMessageFromEvent(event);
      if (syntheticMessage) {
        agentState = reduceAgentMessage(agentState, syntheticMessage, line.ts_ms ?? 0);
      }
    }

    if (event.type === "user_approval") {
      agentState = resolveApproval(agentState, event.approval_id);
    }

    pushStep(mapEventToTimelineEntry(line), lineIndex, 1);
  });

  flushTerminal();
  return steps;
}

function buildAgentState(
  lines: RecordingLine[],
  hasRecordedAgentMessages = recordingHasAgentMessages(lines),
): AgentSessionState {
  let state = emptyAgentSessionState();

  for (const line of lines) {
    const timestamp = line.ts_ms ?? 0;

    if (line.agent_ui_message) {
      state = reduceAgentMessage(state, line.agent_ui_message, timestamp);
    } else if (!hasRecordedAgentMessages && line.event) {
      const synthetic = agentMessageFromEvent(line.event);
      if (synthetic) {
        state = reduceAgentMessage(state, synthetic, timestamp);
      }
    }

    if (line.event?.type === "user_approval") {
      state = resolveApproval(state, line.event.approval_id);
    }
  }

  return state;
}

function recordingHasAgentMessages(lines: RecordingLine[]) {
  return lines.some((line) => Boolean(line.agent_ui_message));
}

function shouldSkipEventInTimeline(event: BusEvent, hasRecordedAgentMessages: boolean) {
  return (
    hasRecordedAgentMessages &&
    (event.type === "agent_status" ||
      event.type === "agent_tool_call" ||
      event.type === "agent_file_edit" ||
      event.type === "agent_finished")
  );
}

function mapEventToTimelineEntry(line: RecordingLine): TimelineEntry {
  const event = line.event!;

  switch (event.type) {
    case "session_created":
      return {
        tsMs: line.ts_ms ?? null,
        kind: "lifecycle",
        title: "Session created",
        detail: event.agent_id ? `agent ${event.agent_id}` : "interactive shell",
        tone: "success",
      };
    case "session_exited":
      return {
        tsMs: line.ts_ms ?? null,
        kind: "lifecycle",
        title: "Session exited",
        detail:
          typeof event.exit_code === "number" ? `exit code ${event.exit_code}` : "exit code unknown",
        tone: event.exit_code === 0 ? "success" : "warning",
      };
    case "user_approval":
      return {
        tsMs: line.ts_ms ?? null,
        kind: "approval",
        title: "Approval resolved",
        detail: `${event.choice} · ${event.approval_id}`,
        tone: "warning",
      };
    case "resize":
      return {
        tsMs: line.ts_ms ?? null,
        kind: "resize",
        title: "Viewport resized",
        detail: `${event.cols} cols × ${event.rows} rows`,
        tone: "neutral",
      };
    case "rule_triggered":
      return {
        tsMs: line.ts_ms ?? null,
        kind: "agent",
        title: `Rule triggered · ${event.rule_name}`,
        detail: `${event.launched_agent_id} → ${event.launched_session_id}`,
        tone: "success",
      };
    case "pty_input":
    case "pty_output":
      return {
        tsMs: line.ts_ms ?? null,
        kind: "terminal",
        title: event.type === "pty_output" ? "Terminal output" : "Terminal input",
        detail: formatBytes(event.bytes.length),
        tone: "neutral",
      };
    case "agent_status":
    case "agent_tool_call":
    case "agent_file_edit":
    case "agent_finished":
      return mapAgentMessageToTimelineEntry(line.ts_ms ?? null, agentMessageFromEvent(event)!);
  }
}

function mapAgentMessageToTimelineEntry(
  tsMs: number | null,
  message: AgentUiMessage,
): TimelineEntry {
  switch (message.type) {
    case "Ready":
      return {
        tsMs,
        kind: "agent",
        title: `Agent ready · ${message.data.agent}`,
        detail: message.data.version ?? "version unspecified",
        tone: "success",
      };
    case "Status":
      return {
        tsMs,
        kind: "agent",
        title: `Agent status · ${message.data.phase}`,
        detail: message.data.detail ?? "status update",
        tone: "neutral",
      };
    case "Progress":
      return {
        tsMs,
        kind: "agent",
        title: `Progress · ${message.data.pct}%`,
        detail: message.data.message,
        tone: "neutral",
      };
    case "Finished":
      return {
        tsMs,
        kind: "agent",
        title: "Agent finished",
        detail:
          typeof message.data.exit_code === "number"
            ? `${message.data.summary} · exit ${message.data.exit_code}`
            : message.data.summary,
        tone:
          message.data.exit_code === 0 || message.data.exit_code == null
            ? "success"
            : "warning",
      };
    case "ToolCall":
      return {
        tsMs,
        kind: "agent",
        title: `Tool call · ${message.data.name}`,
        detail: summarizeJson(message.data.args),
        tone: "neutral",
      };
    case "ToolResult":
      return {
        tsMs,
        kind: "agent",
        title: `Tool result · ${message.data.id}`,
        detail: message.data.error ? message.data.error : summarizeJson(message.data.result),
        tone: message.data.error ? "warning" : "success",
      };
    case "FileEdit":
      return {
        tsMs,
        kind: "agent",
        title: "File edited",
        detail: message.data.path,
        tone: "neutral",
      };
    case "FileCreate":
      return {
        tsMs,
        kind: "agent",
        title: "File created",
        detail: message.data.path,
        tone: "success",
      };
    case "FileDelete":
      return {
        tsMs,
        kind: "agent",
        title: "File deleted",
        detail: message.data.path,
        tone: "warning",
      };
    case "Approval":
      return {
        tsMs,
        kind: "approval",
        title: "Approval requested",
        detail: `${message.data.message} · ${message.data.options.join(", ") || "no options"}`,
        tone: "warning",
      };
    case "Notification":
      return {
        tsMs,
        kind: "agent",
        title: `Notification · ${message.data.level}`,
        detail: message.data.message,
        tone: notificationTone(message.data.level),
      };
    case "Widget":
      return {
        tsMs,
        kind: "agent",
        title: `Widget · ${message.data.widget_type}`,
        detail: summarizeJson(message.data.props),
        tone: "neutral",
      };
  }
}

function agentMessageFromEvent(event: BusEvent): AgentUiMessage | null {
  switch (event.type) {
    case "agent_status":
      return {
        type: "Status",
        data: {
          phase: event.phase,
          detail: event.detail,
        },
      };
    case "agent_tool_call":
      return {
        type: "ToolCall",
        data: {
          id: `legacy-${event.tool}`,
          name: event.tool,
          args: event.args,
        },
      };
    case "agent_file_edit":
      return {
        type: "FileEdit",
        data: {
          path: event.path,
        },
      };
    case "agent_finished":
      return {
        type: "Finished",
        data: {
          summary: event.summary,
          exit_code: event.exit_code,
        },
      };
    default:
      return null;
  }
}

function notificationTone(level: string): TimelineEntry["tone"] {
  const normalized = level.toLowerCase();
  if (normalized.includes("error") || normalized.includes("warn")) {
    return "warning";
  }
  if (normalized.includes("success") || normalized.includes("ok")) {
    return "success";
  }
  return "neutral";
}

function sumBytes(events: Array<Extract<BusEvent, { bytes: number[] }>>) {
  return events.reduce((total, event) => total + event.bytes.length, 0);
}

function summarizeJson(value: unknown) {
  const raw = JSON.stringify(value);
  if (!raw) return "no data";
  return raw.length > 96 ? `${raw.slice(0, 95)}...` : raw;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
