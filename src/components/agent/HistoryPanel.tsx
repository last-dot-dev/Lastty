import { useEffect, useMemo, useRef, useState } from "react";

import type { HistoryEntry, HistorySource } from "../../lib/ipc";
import {
  deleteHistoryEntry,
  listHistory,
  setHistoryEntryPinned,
} from "../../lib/ipc";

const RECENT_LIMIT = 20;

interface HistoryPanelProps {
  activeSessionId: string;
  onResume: (entry: HistoryEntry) => void;
  onViewTranscript: (entry: HistoryEntry) => void;
  onClose: () => void;
}

export default function HistoryPanel({
  activeSessionId,
  onResume,
  onViewTranscript,
  onClose,
}: HistoryPanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    listHistory()
      .then(setEntries)
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return entries.slice(0, RECENT_LIMIT);
    return entries.filter((entry) => matchesQuery(entry, needle));
  }, [entries, query]);

  const handleDelete = async (sessionId: string) => {
    try {
      await deleteHistoryEntry(sessionId);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleTogglePin = async (entry: HistoryEntry) => {
    try {
      await setHistoryEntryPinned(entry.session_id, !entry.pinned);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div ref={panelRef} className="history-panel" role="dialog" aria-label="history">
      <input
        autoFocus
        type="text"
        placeholder="Search history..."
        className="history-panel__search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && <div className="history-panel__error">{error}</div>}
      {entries === null && <div className="history-panel__empty">Loading...</div>}
      {entries !== null && filtered.length === 0 && (
        <div className="history-panel__empty">
          {query ? "No matches" : "No past conversations"}
        </div>
      )}
      <ul className="history-panel__list">
        {filtered.map((entry) => {
          const active = entry.session_id === activeSessionId;
          const imported = entry.source !== "lastty";
          return (
            <li
              key={entry.session_id}
              className={`history-panel__row ${active ? "is-active" : ""} ${entry.pinned ? "is-pinned" : ""}`}
            >
              <button
                type="button"
                className="history-panel__row-main"
                title={
                  entry.agent_session_id
                    ? `Resume ${entry.agent_id ?? "session"}`
                    : `Open new shell at ${entry.cwd}`
                }
                onClick={() => onResume(entry)}
              >
                <span className="history-panel__title" title={entry.title}>
                  {entryDisplayTitle(entry)}
                </span>
                <span className="history-panel__meta">
                  {imported && (
                    <span className="history-panel__source-badge">
                      {sourceBadgeLabel(entry.source)}
                    </span>
                  )}
                  <span className="history-panel__cwd">{cwdBasename(entry.cwd)}</span>
                  <span className="history-panel__time">
                    {formatRelative(entry.last_event_ms)}
                  </span>
                </span>
              </button>
              <div className="history-panel__actions">
                <button
                  type="button"
                  className="history-panel__icon-btn"
                  title="View transcript"
                  aria-label="view transcript"
                  onClick={() => onViewTranscript(entry)}
                >
                  <TranscriptIcon />
                </button>
                {!imported && (
                  <>
                    <button
                      type="button"
                      className={`history-panel__icon-btn ${entry.pinned ? "is-on" : ""}`}
                      title={entry.pinned ? "Unpin" : "Pin"}
                      aria-label={entry.pinned ? "unpin" : "pin"}
                      onClick={() => void handleTogglePin(entry)}
                    >
                      <PinIcon filled={entry.pinned} />
                    </button>
                    <button
                      type="button"
                      className="history-panel__icon-btn"
                      title="Delete"
                      aria-label="delete"
                      onClick={() => void handleDelete(entry.session_id)}
                    >
                      <TrashIcon />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TranscriptIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5h16M4 10h16M4 15h10M4 20h16" />
    </svg>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2l3 5 5 1-3.5 3.5L18 17l-6-3-6 3 1.5-5.5L4 8l5-1z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

function matchesQuery(entry: HistoryEntry, needle: string) {
  const haystacks = [
    entry.title,
    entry.cwd,
    entry.agent_id ?? "",
    entry.prompt_summary ?? "",
  ];
  return haystacks.some((text) => text.toLowerCase().includes(needle));
}

function entryDisplayTitle(entry: HistoryEntry) {
  if (entry.title && entry.title !== "shell") return entry.title;
  if (entry.prompt_summary) return entry.prompt_summary;
  if (entry.agent_id) return `${entry.agent_id} @ ${cwdBasename(entry.cwd)}`;
  return `shell @ ${cwdBasename(entry.cwd)}`;
}

function sourceBadgeLabel(source: HistorySource) {
  switch (source) {
    case "claude_disk":
      return "Claude";
    case "codex_disk":
      return "Codex";
    default:
      return "";
  }
}

function cwdBasename(cwd: string) {
  if (!cwd) return "(unknown)";
  const trimmed = cwd.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || "/";
}

function formatRelative(timestampMs: number) {
  if (!timestampMs) return "";
  const delta = Date.now() - timestampMs;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  const days = Math.floor(delta / 86_400_000);
  if (days < 30) return `${days}d`;
  return new Date(timestampMs).toLocaleDateString();
}
