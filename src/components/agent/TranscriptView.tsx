import { useEffect, useState } from "react";

import { readRecording, type HistoryEntry } from "../../lib/ipc";
import { buildSemanticTimeline, parseRecording, type TimelineEntry } from "../../app/recordings";

interface TranscriptViewProps {
  entry: HistoryEntry;
  onClose: () => void;
}

export default function TranscriptView({ entry, onClose }: TranscriptViewProps) {
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readRecording(entry.session_id)
      .then((raw) => {
        if (cancelled) return;
        setTimeline(buildSemanticTimeline(parseRecording(raw)));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.session_id]);

  return (
    <div className="transcript-view">
      <div className="transcript-view__banner">
        <span className="transcript-view__banner-title">Viewing history</span>
        <span className="transcript-view__banner-meta">
          {entry.title || entry.session_id}
          {entry.exit_code != null && ` · exit ${entry.exit_code}`}
        </span>
        <button
          type="button"
          className="transcript-view__close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="transcript-view__body">
        {error && <div className="transcript-view__error">{error}</div>}
        {!error && timeline === null && (
          <div className="transcript-view__empty">Loading transcript...</div>
        )}
        {timeline !== null && timeline.length === 0 && (
          <div className="transcript-view__empty">No recorded activity</div>
        )}
        {timeline !== null && timeline.length > 0 && (
          <ul className="transcript-view__list">
            {timeline.map((step, index) => (
              <li
                key={`${step.tsMs ?? index}-${index}`}
                className={`transcript-view__row is-${step.tone} is-${step.kind}`}
              >
                <span className="transcript-view__time">
                  {step.tsMs ? new Date(step.tsMs).toLocaleTimeString() : ""}
                </span>
                <span className="transcript-view__title">{step.title}</span>
                <span className="transcript-view__detail">{step.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
