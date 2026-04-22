import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  emptyAgentSessionState,
  reduceAgentMessage,
  resolveApproval,
  visibleNotifications,
  type AgentSessionState,
  type AgentUiMessage,
} from "./agentUi";

interface AgentStore {
  sessions: Record<string, AgentSessionState>;
  ingest: (sessionId: string, message: AgentUiMessage) => void;
  resolveApproval: (sessionId: string, approvalId: string) => void;
  forgetSession: (sessionId: string) => void;
  reset: () => void;
}

export const useAgentStore = create<AgentStore>((set) => ({
  sessions: {},
  ingest: (sessionId, message) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: reduceAgentMessage(
          state.sessions[sessionId] ?? emptyAgentSessionState(),
          message,
        ),
      },
    })),
  resolveApproval: (sessionId, approvalId) =>
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: resolveApproval(existing, approvalId),
        },
      };
    }),
  forgetSession: (sessionId) =>
    set((state) => {
      if (!state.sessions[sessionId]) return state;
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),
  reset: () => set({ sessions: {} }),
}));

const EMPTY: AgentSessionState = emptyAgentSessionState();

export function useAgentSession(sessionId: string | null | undefined): AgentSessionState {
  return useAgentStore((state) =>
    sessionId ? state.sessions[sessionId] ?? EMPTY : EMPTY,
  );
}

export interface ToastEntry {
  sessionId: string;
  notification: AgentSessionState["notifications"][number];
}

export function useVisibleToasts(clock: number, ttlMs = 5_000): ToastEntry[] {
  return useAgentStore(
    useShallow((state) =>
      Object.entries(state.sessions).flatMap(([sessionId, session]) =>
        visibleNotifications(session, clock, ttlMs).map((notification) => ({
          sessionId,
          notification,
        })),
      ),
    ),
  );
}

export function useBlockedSessionIds(): string[] {
  return useAgentStore(
    useShallow((state) =>
      Object.entries(state.sessions)
        .filter(([, session]) => session.pendingApprovals.length > 0)
        .map(([sessionId]) => sessionId),
    ),
  );
}
