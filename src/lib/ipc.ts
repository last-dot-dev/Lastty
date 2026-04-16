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
