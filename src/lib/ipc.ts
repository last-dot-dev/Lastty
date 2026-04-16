import { invoke } from "@tauri-apps/api/core";

export async function createTerminal(
  cwd: string,
  command?: string,
): Promise<string> {
  return invoke("create_terminal", { cwd, command });
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
): Promise<void> {
  return invoke("key_input", { key, code, ctrl, alt, shift, meta });
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

export async function getRendererMode(): Promise<string | null> {
  return invoke("get_renderer_mode");
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

export async function getTerminalFrame(
  sessionId: string,
): Promise<TerminalFrame> {
  return invoke("get_terminal_frame", { sessionId });
}
