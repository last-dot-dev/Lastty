import { invoke } from "@tauri-apps/api/core";

export async function createTerminal(
  cwd?: string,
  command?: string,
  args?: string[],
): Promise<string> {
  return invoke("create_terminal", { cwd, command, args });
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
  return invoke("key_input", {
    input: { key, code, ctrl, alt, shift, meta, sessionId },
  });
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

export interface StressBenchConfig {
  duration_ms: number;
  panes: number;
  scenarios: string[];
  simulator_path: string;
  cols: number;
  rows: number;
  output_path: string;
}

export async function getStressBenchConfig(): Promise<StressBenchConfig> {
  return invoke("get_stress_bench_config");
}

export async function registerStressSession(
  sessionId: string,
  scenario: string,
): Promise<void> {
  return invoke("register_stress_session", { sessionId, scenario });
}

export async function submitStressFrontendSample(
  sessionId: string,
  writeMs: number,
): Promise<void> {
  return invoke("submit_stress_frontend_sample", { sessionId, writeMs });
}

export async function submitStressLifecycle(
  stage: string,
  ms: number,
): Promise<void> {
  return invoke("submit_stress_lifecycle", { stage, ms });
}

export async function finalizeStressBench(
  outputPath: string,
  durationMs: number,
  panes: number,
): Promise<void> {
  return invoke("finalize_stress_bench", {
    outputPath,
    durationMs,
    panes,
  });
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

const commandAvailabilityCache = new Map<string, Promise<boolean>>();

export function checkCommandAvailable(command: string): Promise<boolean> {
  let existing = commandAvailabilityCache.get(command);
  if (!existing) {
    // Fail open: if the IPC itself errors (e.g. missing in test env), treat
    // the command as available so a broken check never hides a working button.
    existing = invoke<boolean>("check_command_available", { command }).catch(
      () => true,
    );
    commandAvailabilityCache.set(command, existing);
  }
  return existing;
}

export async function terminalScroll(
  sessionId: string,
  lines: number,
): Promise<void> {
  return invoke("terminal_scroll", { sessionId, lines });
}

export interface TerminalFrame {
  // Base64-encoded ANSI bytes. Backend switched from `Vec<u8>` (which
  // serde_json renders as `[65, 66, ...]` — ~4x bloat) to base64 for IPC
  // efficiency.
  ansi: string;
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
  started_at_unix_ms: number;
}

export type HistorySource = "lastty" | "claude_disk" | "codex_disk";

export interface HistoryEntry {
  session_id: string;
  title: string;
  agent_id: string | null;
  cwd: string;
  worktree_path: string | null;
  prompt_summary: string | null;
  started_at_ms: number;
  last_event_ms: number;
  exit_code: number | null;
  pinned: boolean;
  agent_session_id: string | null;
  source: HistorySource;
}

export interface ResumeHistoryEntryResult {
  session_id: string;
  cwd: string;
  agent_id: string | null;
  resumed: boolean;
}

export interface GitInfo {
  repo: string;
  branch: string;
}

export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  return invoke("get_git_info", { cwd });
}

export interface GitCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  committed_at: number;
  refs: string[];
}

export interface GitGraph {
  commits: GitCommit[];
  head: string | null;
  head_ref: string | null;
}

export async function gitGraph(cwd: string, limit?: number): Promise<GitGraph> {
  return invoke("git_graph", { cwd, limit });
}

export interface GitBranch {
  name: string;
  is_current: boolean;
  worktree_path: string | null;
}

export async function listGitBranches(cwd: string): Promise<GitBranch[]> {
  return invoke("list_git_branches", { cwd });
}

export async function checkoutGitBranch(
  cwd: string,
  name: string,
): Promise<void> {
  return invoke("checkout_git_branch", { cwd, name });
}

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  is_lastty: boolean;
  detached: boolean;
}

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "type_change"
  | "conflicted"
  | "other";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

export interface WorktreeStatus {
  uncommitted_files: number;
  unmerged_commits: number;
  base_branch: string | null;
  changed_files: ChangedFile[];
}

export interface CreatePrRequest {
  worktree_path: string;
  target_branch: string;
  title?: string | null;
  body?: string | null;
  auto_commit_message?: string | null;
}

export interface CreatePrResult {
  url: string;
  branch: string;
  committed: boolean;
  pushed: boolean;
  already_existed: boolean;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  return invoke("list_worktrees", { cwd });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return invoke("is_git_repo", { cwd });
}

export async function worktreeStatus(
  path: string,
  baseBranch: string,
): Promise<WorktreeStatus> {
  return invoke("worktree_status", { path, baseBranch });
}

export async function createPullRequest(
  req: CreatePrRequest,
): Promise<CreatePrResult> {
  return invoke("create_pull_request", { req });
}

export async function removeWorktree(
  path: string,
  repoRoot: string,
): Promise<void> {
  return invoke("remove_worktree", { path, repoRoot });
}

export async function getWorkspaceRoot(): Promise<string> {
  return invoke("get_workspace_root");
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
  attach_to_worktree?: string | null;
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

export async function listHistory(): Promise<HistoryEntry[]> {
  return invoke("list_history");
}

export async function getHistoryEntry(
  sessionId: string,
): Promise<HistoryEntry | null> {
  return invoke("get_history_entry", { sessionId });
}

export async function deleteHistoryEntry(sessionId: string): Promise<void> {
  return invoke("delete_history_entry", { sessionId });
}

export async function setHistoryEntryPinned(
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  return invoke("set_history_entry_pinned", { sessionId, pinned });
}

export async function resumeHistoryEntry(
  sessionId: string,
): Promise<ResumeHistoryEntryResult> {
  return invoke("resume_history_entry", { sessionId });
}

export async function getTerminalFrame(
  sessionId: string,
): Promise<TerminalFrame> {
  return invoke("get_terminal_frame", { sessionId });
}

