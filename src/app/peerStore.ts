import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  Addr,
  PeerMessage,
  PeerMessageEvent,
  PeerPresenceEvent,
  Presence,
} from "./peerTypes";

export interface ChannelEntry {
  id: number;
  from: Addr;
  kind: PeerMessageEvent["kind"];
  body: unknown;
  tsMs: number;
}

interface PeerStore {
  channelMessages: Record<string, ChannelEntry[]>;
  presence: Record<string, Presence>;
  ingestMessage: (event: PeerMessageEvent) => void;
  ingestPresence: (event: PeerPresenceEvent) => void;
  reset: () => void;
}

let entryCounter = 0;

export const usePeerStore = create<PeerStore>((set) => ({
  channelMessages: {},
  presence: {},
  ingestMessage: (event) =>
    set((state) => {
      const channelKey = event.channel ?? (event.to.kind === "user" ? "__user" : null);
      if (!channelKey) return state;
      const entry: ChannelEntry = {
        id: ++entryCounter,
        from: event.from,
        kind: event.kind,
        body: event.body,
        tsMs: Date.now(),
      };
      const current = state.channelMessages[channelKey] ?? [];
      return {
        channelMessages: {
          ...state.channelMessages,
          [channelKey]: [...current, entry].slice(-200),
        },
      };
    }),
  ingestPresence: (event) =>
    set((state) => ({
      presence: { ...state.presence, [event.session_id]: event.status },
    })),
  reset: () => set({ channelMessages: {}, presence: {} }),
}));

export async function sendPeerMessage(
  message: PeerMessage,
  contextSessionId?: string,
): Promise<void> {
  return invoke("send_peer_message", {
    contextSessionId: contextSessionId ?? null,
    message,
  });
}

export function useChannelMessages(channel: string): ChannelEntry[] {
  return usePeerStore((state) => state.channelMessages[channel] ?? EMPTY);
}

export function useAgentPresence(sessionId: string | undefined): Presence | null {
  return usePeerStore((state) =>
    sessionId ? state.presence[sessionId] ?? null : null,
  );
}

const EMPTY: ChannelEntry[] = [];
