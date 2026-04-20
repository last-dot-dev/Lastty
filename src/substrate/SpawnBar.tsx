import { useState } from "react";

import { spawnGenerative, spawnSeed } from "./ipc";
import type { SpawnedApp } from "./types";

export function SpawnBar({
  onSpawn,
}: {
  onSpawn: (app: SpawnedApp) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value || busy) return;
        setBusy(true);
        setError(null);
        try {
          onSpawn(await spawnGenerative(value));
          setValue("");
        } catch (err) {
          setError(String(err));
        } finally {
          setBusy(false);
        }
      }}
      style={{
        padding: 10,
        borderBottom: "1px solid #1a1a1c",
        display: "flex",
        gap: 8,
        alignItems: "center",
      }}
    >
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onSpawn(await spawnSeed("planner"));
          } catch (err) {
            setError(String(err));
          } finally {
            setBusy(false);
          }
        }}
        style={{
          padding: "5px 10px",
          background: "#1a1a1c",
          color: "#ddd",
          border: "1px solid #333",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        + planner (seed)
      </button>
      <input
        style={{
          flex: 1,
          background: "#111",
          color: "#ddd",
          border: "1px solid #333",
          padding: "6px 10px",
          borderRadius: 4,
          fontSize: 13,
        }}
        placeholder="describe an app... (e.g. plan a Tokyo trip)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        disabled={busy}
        style={{
          padding: "5px 12px",
          background: "#2d5fa3",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: busy ? "wait" : "pointer",
          fontSize: 12,
        }}
      >
        {busy ? "..." : "spawn"}
      </button>
      {error && (
        <span style={{ color: "#f55", fontSize: 11, maxWidth: 240 }}>
          {error}
        </span>
      )}
    </form>
  );
}
