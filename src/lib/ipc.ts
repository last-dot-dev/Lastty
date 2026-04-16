import { invoke } from "@tauri-apps/api/core";

export async function createTerminal(
  cwd?: string,
  command?: string,
): Promise<string> {
  return invoke("create_terminal", { cwd, command });
}

export interface RestoreTerminalRequest {
  cwd: string;
}

export async function terminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { sessionId, cols, rows });
}

export async function killTerminal(sessionId: string): Promise<void> {
  return invoke("kill_terminal", { sessionId });
}

export async function sendKeyEvent(
  key: string,
  code: string,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  meta: boolean,
  sessionId?: string,
): Promise<void> {
  return invoke("key_input", { key, code, ctrl, alt, shift, meta, sessionId });
}

export async function writeBenchmarkReport(
  path: string,
  contents: string,
): Promise<void> {
  return invoke("write_benchmark_report", { path, contents });
}

export async function quitApp(): Promise<void> {
  return invoke("quit_app");
}

export async function getBenchmarkMode(): Promise<string | null> {
  return invoke("get_benchmark_mode");
}

export interface BenchmarkConfig {
  cols: number;
  rows: number;
  iterations: number;
  warmup_iterations: number;
  output_path: string;
  force_failure_message?: string | null;
}

export async function getBenchmarkConfig(): Promise<BenchmarkConfig> {
  return invoke("get_benchmark_config");
}

export async function getRendererMode(): Promise<string | null> {
  return invoke("get_renderer_mode");
}

export interface FontConfig {
  family: string;
  size_px: number;
  line_height: number;
}

export async function getFontConfig(): Promise<FontConfig> {
  return invoke("get_font_config");
}

export async function getPrimarySessionId(): Promise<string | null> {
  return invoke("get_primary_session_id");
}

export async function terminalInput(
  sessionId: string,
  bytes: number[],
): Promise<void> {
  return invoke("terminal_input", { sessionId, bytes });
}

export interface TerminalFrame {
  ansi: number[];
  cursor_x: number;
  cursor_y: number;
  cursor_visible: boolean;
  display_offset: number;
  total_lines: number;
  alternate_screen: boolean;
}

export interface TerminalFrameEvent {
  session_id: string;
  frame: TerminalFrame;
}

export interface SessionTitleEvent {
  session_id: string;
  title: string;
}

export interface SessionExitEvent {
  session_id: string;
  code?: number | null;
}

export interface AgentUiEvent {
  session_id: string;
  message: unknown;
}

export interface SessionInfo {
  session_id: string;
  title: string;
  agent_id: string | null;
  cwd: string;
  prompt: string | null;
  prompt_summary: string | null;
  worktree_path: string | null;
  control_connected: boolean;
  started_at_ms: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  command: string;
  default_args: string[];
  prompt_transport: unknown;
  shell: boolean;
  env: Record<string, string>;
  icon?: string | null;
}

export interface LaunchAgentRequest {
  agent_id: string;
  prompt?: string | null;
  cwd?: string | null;
  isolate_in_worktree?: boolean;
  branch_name?: string | null;
}

export interface LaunchAgentResult {
  session_id: string;
  pane_title: string;
  cwd: string;
  worktree_path?: string | null;
}

export interface RuleFilter {
  agent_id?: string | null;
  session_id?: string | null;
  phase?: string | null;
  tool?: string | null;
  path?: string | null;
  choice?: string | null;
}

export interface RuleTrigger {
  event: string;
  filter: RuleFilter;
}

export interface RuleAction {
  launch_agent: string;
  prompt?: string | null;
  cwd?: string | null;
  isolate_in_worktree: boolean;
  branch_name?: string | null;
}

export interface RuleDefinition {
  name: string;
  trigger: RuleTrigger;
  action: RuleAction;
  debounce_ms?: number | null;
}

export interface RecordingInfo {
  session_id: string;
  path: string;
  size_bytes: number;
}

export type BusEvent =
  | { type: "session_created"; session_id: string; agent_id?: string | null }
  | { type: "session_exited"; session_id: string; exit_code?: number | null }
  | {
      type: "agent_status";
      session_id: string;
      agent_id?: string | null;
      phase: string;
      detail?: string | null;
    }
  | {
      type: "agent_tool_call";
      session_id: string;
      agent_id?: string | null;
      tool: string;
      args: unknown;
    }
  | { type: "agent_file_edit"; session_id: string; agent_id?: string | null; path: string }
  | {
      type: "agent_finished";
      session_id: string;
      agent_id?: string | null;
      summary: string;
      exit_code?: number | null;
    }
  | {
      type: "user_approval";
      session_id: string;
      approval_id: string;
      choice: string;
    }
  | { type: "pty_input"; session_id: string; bytes: number[] }
  | { type: "pty_output"; session_id: string; bytes: number[] }
  | { type: "resize"; session_id: string; cols: number; rows: number }
  | {
      type: "rule_triggered";
      session_id: string;
      rule_name: string;
      launched_session_id: string;
      launched_agent_id: string;
    };

export async function listSessions(): Promise<SessionInfo[]> {
  return invoke("list_sessions");
}

export async function restoreTerminalSessions(
  sessions: RestoreTerminalRequest[],
): Promise<SessionInfo[]> {
  return invoke("restore_terminal_sessions", { sessions });
}

export async function listAgents(): Promise<AgentDefinition[]> {
  return invoke("list_agents");
}

export async function listRules(): Promise<RuleDefinition[]> {
  return invoke("list_rules");
}

export async function launchAgent(
  request: LaunchAgentRequest,
): Promise<LaunchAgentResult> {
  return invoke("launch_agent", { request });
}

export async function respondToApproval(
  sessionId: string,
  approvalId: string,
  choice: string,
): Promise<void> {
  return invoke("respond_to_approval", { sessionId, approvalId, choice });
}

export async function listRecordings(): Promise<RecordingInfo[]> {
  return invoke("list_recordings");
}

export async function readRecording(sessionId: string): Promise<string> {
  return invoke("read_recording", { sessionId });
}

export async function getTerminalFrame(
  sessionId: string,
): Promise<TerminalFrame> {
  return invoke("get_terminal_frame", { sessionId });
}

export interface PaneLayoutEntry {
  session_id: string;
  /// AppKit points (≈ CSS px on macOS) relative to the window's content view.
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function updatePaneLayout(panes: PaneLayoutEntry[]): Promise<void> {
  return invoke("update_pane_layout", { panes });
}
