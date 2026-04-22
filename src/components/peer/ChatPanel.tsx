import { useEffect, useRef, useState } from "react";
import {
  sendPeerMessage,
  useChannelMessages,
} from "../../app/peerStore";
import { addrLabel } from "../../app/peerTypes";

const DEFAULT_CHANNEL = "general";

export function ChatPanel({
  open,
  onClose,
  channel = DEFAULT_CHANNEL,
}: {
  open: boolean;
  onClose: () => void;
  channel?: string;
}) {
  const messages = useChannelMessages(channel);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  if (!open) return null;

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await sendPeerMessage({
        type: "post",
        channel,
        body: { text },
      });
      setDraft("");
    } catch (error) {
      console.error("send_peer_message failed", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="peer chat"
      style={{
        position: "fixed",
        right: 14,
        bottom: 14,
        width: 320,
        height: 380,
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-secondary)",
        borderRadius: "var(--border-radius-md)",
        boxShadow: "var(--elev-shadow)",
        color: "var(--color-text-primary)",
        zIndex: 60,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 10px",
          borderBottom: "0.5px solid var(--color-border-tertiary)",
          fontSize: 12,
        }}
      >
        <span>#{channel}</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "transparent",
            border: 0,
            color: "var(--color-text-secondary)",
            cursor: "pointer",
            fontSize: 14,
          }}
          aria-label="Close chat"
        >
          ×
        </button>
      </header>
      <div
        ref={listRef}
        style={{
          overflow: "auto",
          padding: 10,
          display: "grid",
          gap: 6,
          fontSize: 12,
          alignContent: "start",
        }}
      >
        {messages.length === 0 ? (
          <div style={{ color: "var(--color-text-tertiary)" }}>
            No messages yet. Your posts go to agents subscribed to #{channel}.
          </div>
        ) : (
          messages.map((entry) => (
            <div key={entry.id}>
              <span style={{ color: "var(--color-text-tertiary)", marginRight: 6 }}>
                {addrLabel(entry.from)}
              </span>
              <span>{renderBody(entry.body)}</span>
            </div>
          ))
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderTop: "0.5px solid var(--color-border-tertiary)",
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Message #${channel}`}
          disabled={busy}
          style={{
            flex: 1,
            fontSize: 12,
            padding: "4px 6px",
            borderRadius: "var(--border-radius-sm)",
            border: "0.5px solid var(--color-border-secondary)",
            background: "var(--color-background-secondary)",
            color: "inherit",
          }}
          autoFocus
        />
        <button
          type="submit"
          disabled={busy || draft.trim().length === 0}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: "var(--border-radius-sm)",
            border: "0.5px solid var(--color-border-secondary)",
            background: "var(--color-background-secondary)",
            color: "inherit",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function renderBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && "text" in body) {
    const text = (body as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}
