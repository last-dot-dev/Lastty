import { useEffect, useState } from "react";

import { appHistory, forkApp, materializeAt } from "./ipc";
import { RenderNode } from "./primitives";
import type { HistoryEntry, SpawnedApp } from "./types";
import { useAppDoc } from "./useAppDoc";

export function AppPane({
  app,
  onFork,
  onClose,
}: {
  app: SpawnedApp;
  onFork?: (forked: SpawnedApp) => void;
  onClose?: () => void;
}) {
  const live = useAppDoc(app.id);
  const [scrubIdx, setScrubIdx] = useState<number>(-1);
  const [hist, setHist] = useState<HistoryEntry[]>([]);
  const [scrubbed, setScrubbed] = useState<unknown | null>(null);

  useEffect(() => {
    appHistory(app.id).then(setHist);
    const t = setInterval(() => {
      appHistory(app.id).then(setHist);
    }, 2000);
    return () => clearInterval(t);
  }, [app.id]);

  const doc = scrubIdx >= 0 ? scrubbed : (live ?? app.doc);

  return (
    <div
      data-app-id={app.id}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0b",
        border: "1px solid #1a1a1c",
        borderRadius: 8,
        minWidth: 320,
        maxWidth: 480,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid #1a1a1c",
          fontSize: 11,
          color: "#888",
        }}
      >
        <span>
          {app.kind} · {app.id.slice(0, 6)}
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          <button
            onClick={async () => {
              const f = await forkApp(app.id);
              if (onFork) onFork(f);
            }}
            style={paneBtn}
          >
            fork
          </button>
          {onClose && (
            <button onClick={onClose} style={paneBtn}>
              ×
            </button>
          )}
        </span>
      </div>
      <div
        style={{
          padding: 12,
          color: "#ddd",
          fontFamily: "system-ui",
          fontSize: 13,
        }}
      >
        <RenderNode node={app.view.root} doc={doc} ctx={{ appId: app.id }} />
      </div>
      {hist.length > 0 && (
        <div
          style={{
            padding: "4px 10px 8px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 10,
            color: "#666",
          }}
        >
          <input
            type="range"
            min={-1}
            max={hist.length - 1}
            value={scrubIdx}
            onChange={async (e) => {
              const n = Number(e.target.value);
              setScrubIdx(n);
              if (n < 0) {
                setScrubbed(null);
              } else {
                const snap = await materializeAt(app.id, [hist[n].hash]);
                setScrubbed(snap);
              }
            }}
            style={{ flex: 1 }}
          />
          <span>{scrubIdx < 0 ? "live" : `@${hist[scrubIdx]?.hash.slice(0, 6)}`}</span>
        </div>
      )}
    </div>
  );
}

const paneBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "#161618",
  color: "#bbb",
  border: "1px solid #262628",
  borderRadius: 3,
  cursor: "pointer",
  fontSize: 10,
};
