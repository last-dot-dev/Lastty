import { useEffect, useState, type ReactNode } from "react";

import type { GraphLayout } from "../../lib/graphLayout";

export type SidebarGraph =
  | { state: "idle"; reason: string }
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      layout: GraphLayout;
      headSha: string | null;
      headRef: string | null;
    };

const WIDTH_KEY = "lastty.sidebar.width";
const WIDTH_MIN = 180;
const WIDTH_MAX = 600;

function loadNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  } catch {
    return fallback;
  }
}

function storeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

export default function Sidebar({
  projectRoot,
  onChangeProjectRoot,
  footerExtras,
  sessionsSlot,
  graphSlot,
}: {
  projectRoot: string;
  onChangeProjectRoot: () => void;
  footerExtras?: ReactNode;
  sessionsSlot: ReactNode;
  graphSlot?: ReactNode;
}) {
  const [width, setWidth] = useState(() => loadNumber(WIDTH_KEY, 240, WIDTH_MIN, WIDTH_MAX));

  useEffect(() => storeNumber(WIDTH_KEY, width), [width]);

  const startWidthDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (moveEvent.clientX - startX);
      setWidth(Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, next)));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  return (
    <aside
      className="agent-sidebar"
      style={{ width, minWidth: width }}
      aria-label="sessions"
    >
      <div className="agent-sidebar__project">
        <span
          className="agent-sidebar__project-path"
          title={projectRoot || "no project folder picked"}
        >
          {projectRoot ? projectRoot.split("/").filter(Boolean).slice(-2).join("/") : "no folder"}
        </span>
        <button
          type="button"
          className="agent-sidebar__project-change"
          onClick={onChangeProjectRoot}
          title="change project folder"
        >
          change
        </button>
      </div>
      <div className="agent-sidebar__section is-sessions">
        <div className="agent-sidebar__label">Sessions</div>
        {sessionsSlot}
      </div>
      {graphSlot && (
        <div className="agent-sidebar__section is-graph">
          <div className="agent-sidebar__label">Graph</div>
          <div className="agent-sidebar__graph-body">{graphSlot}</div>
        </div>
      )}
      {footerExtras && (
        <div className="agent-sidebar__footer">
          <div className="agent-sidebar__footer-row">{footerExtras}</div>
        </div>
      )}
      <div
        className="agent-sidebar__width-handle"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startWidthDrag}
      />
    </aside>
  );
}
