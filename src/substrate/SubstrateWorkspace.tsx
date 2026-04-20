import { useEffect, useState } from "react";

import { AppPane } from "./AppPane";
import { CompareApp } from "./CompareApp";
import { forkApp } from "./ipc";
import { SpawnBar } from "./SpawnBar";
import type { AppId, SpawnedApp } from "./types";

interface Entry {
  kind: "app" | "compare";
  id: string;
  app?: SpawnedApp;
  a?: SpawnedApp;
  b?: SpawnedApp;
}

export function SubstrateWorkspace() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [focus, setFocus] = useState<AppId | null>(null);
  const [lastTwo, setLastTwo] = useState<AppId[]>([]);

  const apps = entries.filter((e) => e.kind === "app").map((e) => e.app!);
  const focusApp = apps.find((a) => a.id === focus) ?? apps[apps.length - 1];

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "f" && focusApp) {
        e.preventDefault();
        const forked = await forkApp(focusApp.id);
        setEntries((prev) => [
          ...prev,
          { kind: "app", id: forked.id, app: forked },
        ]);
        setFocus(forked.id);
      } else if (key === "c" && e.shiftKey && lastTwo.length === 2) {
        e.preventDefault();
        const a = apps.find((x) => x.id === lastTwo[0]);
        const b = apps.find((x) => x.id === lastTwo[1]);
        if (a && b) {
          setEntries((prev) => [
            ...prev,
            { kind: "compare", id: `cmp-${a.id}-${b.id}`, a, b },
          ]);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusApp, apps, lastTwo]);

  const registerFocus = (id: AppId) => {
    setFocus(id);
    setLastTwo((prev) => {
      const filtered = prev.filter((x) => x !== id);
      return [id, ...filtered].slice(0, 2);
    });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#070708",
        color: "#ddd",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          fontSize: 11,
          color: "#666",
          borderBottom: "1px solid #1a1a1c",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>lastty substrate · ⌘F fork · ⌘⇧C compare · drag list items between cards to merge</span>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            window.location.hash = "";
            window.location.reload();
          }}
          style={{ color: "#888", fontSize: 11, textDecoration: "none" }}
        >
          → terminal
        </a>
      </div>
      <SpawnBar
        onSpawn={(app) => {
          setEntries((prev) => [...prev, { kind: "app", id: app.id, app }]);
          registerFocus(app.id);
        }}
      />
      <div
        style={{
          flex: 1,
          padding: 16,
          overflow: "auto",
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignContent: "flex-start",
        }}
      >
        {entries.map((e) => {
          if (e.kind === "app" && e.app) {
            return (
              <div
                key={e.id}
                onMouseDown={() => registerFocus(e.app!.id)}
                style={{
                  outline:
                    focus === e.app.id ? "1px solid #2d5fa3" : "none",
                  outlineOffset: 2,
                  borderRadius: 8,
                }}
              >
                <AppPane
                  app={e.app}
                  onFork={(f) => {
                    setEntries((prev) => [
                      ...prev,
                      { kind: "app", id: f.id, app: f },
                    ]);
                    registerFocus(f.id);
                  }}
                  onClose={() =>
                    setEntries((prev) => prev.filter((x) => x.id !== e.id))
                  }
                />
              </div>
            );
          }
          if (e.kind === "compare" && e.a && e.b) {
            return (
              <CompareApp
                key={e.id}
                a={e.a}
                b={e.b}
                onClose={() =>
                  setEntries((prev) => prev.filter((x) => x.id !== e.id))
                }
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
