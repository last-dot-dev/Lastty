export type AgentUiMessage =
  | { type: "Ready"; data: { agent: string; version?: string | null } }
  | { type: "Status"; data: { phase: string; detail?: string | null } }
  | { type: "Progress"; data: { pct: number; message: string } }
  | { type: "Finished"; data: { summary: string; exit_code?: number | null } }
  | { type: "ToolCall"; data: { id: string; name: string; args: unknown } }
  | {
      type: "ToolResult";
      data: { id: string; result: unknown; error?: string | null };
    }
  | { type: "FileEdit"; data: { path: string; diff?: string | null } }
  | { type: "FileCreate"; data: { path: string } }
  | { type: "FileDelete"; data: { path: string } }
  | { type: "Approval"; data: { id: string; message: string; options: string[] } }
  | { type: "Notification"; data: { level: string; message: string } }
  | { type: "Widget"; data: { widget_type: string; props: unknown } };

export interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
  result?: unknown;
  error?: string | null;
  timestamp: number;
}

export interface AgentSessionState {
  ready: { agent: string; version?: string | null } | null;
  status: { phase: string; detail?: string | null } | null;
  progress: { pct: number; message: string } | null;
  finished: { summary: string; exitCode?: number | null } | null;
  toolCalls: ToolCallRecord[];
  fileEdits: Array<{ path: string; diff?: string | null; kind: "edit" | "create" | "delete" }>;
  pendingApprovals: Array<{ id: string; message: string; options: string[] }>;
  notifications: Array<{ level: string; message: string; timestamp: number }>;
  widgets: Array<{ widgetType: string; props: unknown; timestamp: number }>;
}

type FileEditKind = "edit" | "create" | "delete";

export function emptyAgentSessionState(): AgentSessionState {
  return {
    ready: null,
    status: null,
    progress: null,
    finished: null,
    toolCalls: [],
    fileEdits: [],
    pendingApprovals: [],
    notifications: [],
    widgets: [],
  };
}

export function reduceAgentMessage(
  state: AgentSessionState,
  message: AgentUiMessage,
  timestamp = Date.now(),
): AgentSessionState {
  switch (message.type) {
    case "Ready":
      return { ...state, ready: message.data };
    case "Status":
      return { ...state, status: message.data };
    case "Progress":
      return { ...state, progress: message.data };
    case "Finished":
      return {
        ...state,
        finished: {
          summary: message.data.summary,
          exitCode: message.data.exit_code,
        },
      };
    case "ToolCall":
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          {
            id: message.data.id,
            name: message.data.name,
            args: message.data.args,
            timestamp,
          },
        ].slice(-50),
      };
    case "ToolResult":
      return {
        ...state,
        toolCalls: state.toolCalls.map((call) =>
          call.id === message.data.id
            ? {
                ...call,
                result: message.data.result,
                error: message.data.error,
              }
            : call,
        ),
      };
    case "FileEdit":
      return {
        ...state,
        fileEdits: [
          ...state.fileEdits,
          fileEdit(message.data.path, "edit", message.data.diff),
        ].slice(-25),
      };
    case "FileCreate":
      return {
        ...state,
        fileEdits: [...state.fileEdits, fileEdit(message.data.path, "create")].slice(-25),
      };
    case "FileDelete":
      return {
        ...state,
        fileEdits: [...state.fileEdits, fileEdit(message.data.path, "delete")].slice(-25),
      };
    case "Approval":
      return {
        ...state,
        pendingApprovals: [...state.pendingApprovals, message.data].slice(-10),
      };
    case "Notification":
      return {
        ...state,
        notifications: [
          ...state.notifications,
          { ...message.data, timestamp },
        ].slice(-20),
      };
    case "Widget":
      return {
        ...state,
        widgets: [
          ...state.widgets,
          { widgetType: message.data.widget_type, props: message.data.props, timestamp },
        ].slice(-10),
      };
  }
}

export function parseAgentMessage(value: unknown): AgentUiMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { type?: unknown; data?: unknown };
  if (typeof candidate.type !== "string" || candidate.data === undefined) return null;
  return candidate as AgentUiMessage;
}

export function resolveApproval(
  state: AgentSessionState,
  approvalId: string,
): AgentSessionState {
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.filter((approval) => approval.id !== approvalId),
  };
}

export function visibleNotifications(
  state: AgentSessionState,
  now = Date.now(),
  ttlMs = 5_000,
) {
  return state.notifications.filter((notification) => now - notification.timestamp <= ttlMs);
}

function fileEdit(path: string, kind: FileEditKind, diff?: string | null) {
  return diff === undefined ? { path, kind } : { path, kind, diff };
}
