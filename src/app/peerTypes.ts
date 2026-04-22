export type Addr =
  | { kind: "session"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "channel"; id: string }
  | { kind: "user" };

export type Presence = "thinking" | "waiting" | "idle" | "done";

export type PeerMessage =
  | { type: "dm"; to: Addr; body: unknown; correlation_id?: string }
  | { type: "post"; channel: string; body: unknown; reply_to?: string }
  | { type: "join"; channel: string }
  | { type: "leave"; channel: string }
  | { type: "presence"; status: Presence }
  | { type: "reply"; correlation_id: string; body: unknown; error?: string };

export interface PeerMessageEvent {
  type: "peer_message";
  session_id: string;
  from: Addr;
  to: Addr;
  kind: "dm" | "post" | "reply" | "join" | "leave";
  channel: string | null;
  correlation_id: string | null;
  body: unknown;
}

export interface PeerPresenceEvent {
  type: "peer_presence";
  session_id: string;
  from: Addr;
  status: Presence;
}

export function addrLabel(addr: Addr): string {
  switch (addr.kind) {
    case "user":
      return "you";
    case "session":
      return `s:${addr.id.slice(0, 6)}`;
    case "agent":
      return `@${addr.id}`;
    case "channel":
      return `#${addr.id}`;
  }
}
