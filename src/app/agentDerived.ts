import type { SessionInfo } from "../lib/ipc";
import type { AgentSessionState } from "./agentUi";

export type AgentStatus = "plan" | "needs_help" | "done";

export const BRANCH_COLOR_PALETTE = [
  "#7F77DD",
  "#1D9E75",
  "#378ADD",
  "#D85A30",
  "#D4537E",
  "#BA7517",
  "#639922",
] as const;

export function deriveAgentStatus(
  ui: AgentSessionState | undefined,
  exited = false,
): AgentStatus {
  if (!ui) return exited ? "done" : "plan";
  if (ui.pendingApprovals.length > 0 || ui.attention) return "needs_help";
  if (ui.finished !== null || exited) return "done";
  return "plan";
}

export function deriveTaskName(info: SessionInfo | undefined): string {
  if (!info) return "shell";
  const summary = info.prompt_summary?.trim();
  if (summary) return summary;
  const title = info.title?.trim();
  if (title) return title;
  return "shell";
}

export function deriveBranchName(info: SessionInfo | undefined): string {
  if (!info?.worktree_path) return "main";
  const segments = info.worktree_path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "main";
}

export function deriveAgentType(info: SessionInfo | undefined): string {
  return info?.agent_id ?? "shell";
}

export function deriveProgressPct(ui: AgentSessionState | undefined): number {
  const pct = ui?.progress?.pct ?? (ui?.finished ? 100 : 0);
  if (Number.isNaN(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function assignBranchColor(sessionId: string, order: string[]): string {
  const index = order.indexOf(sessionId);
  const lane = index >= 0 ? index : hashLane(sessionId, order.length);
  return BRANCH_COLOR_PALETTE[lane % BRANCH_COLOR_PALETTE.length]!;
}

function hashLane(input: string, fallbackLen: number): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  const abs = Math.abs(h);
  return fallbackLen > 0 ? abs : abs % BRANCH_COLOR_PALETTE.length;
}
