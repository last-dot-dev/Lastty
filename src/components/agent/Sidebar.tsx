import { useEffect, useRef, useState, type ReactNode } from "react";

import SessionList, { type SessionRow } from "./SessionList";
import CommitGraph from "./CommitGraph";
import MergeButton from "./MergeButton";
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
const TOP_HEIGHT_KEY = "lastty.sidebar.topHeight";
const WIDTH_MIN = 180;
const WIDTH_MAX = 600;
const TOP_MIN = 60;
const BOTTOM_MIN = 120;

function loadNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
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
  rows,
  doneCount,
  onFocus,
  footerExtras,
  graph,
  nowMs,
}: {
  rows: SessionRow[];
  doneCount: number;
  onFocus: (paneId: string) => void;
  footerExtras?: ReactNode;
  graph: SidebarGraph;
  nowMs: number;
}) {
  const [width, setWidth] = useState(() => loadNumber(WIDTH_KEY, 220));
  const [topHeight, setTopHeight] = useState(() => loadNumber(TOP_HEIGHT_KEY, 200));
  const asideRef = useRef<HTMLElement | null>(null);

  useEffect(() => storeNumber(WIDTH_KEY, width), [width]);
  useEffect(() => storeNumber(TOP_HEIGHT_KEY, topHeight), [topHeight]);

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

  const startTopHeightDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startTop = topHeight;
    const asideHeight = asideRef.current?.clientHeight ?? 0;
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const next = startTop + (moveEvent.clientY - startY);
      const max = Math.max(TOP_MIN, asideHeight - BOTTOM_MIN);
      setTopHeight(Math.max(TOP_MIN, Math.min(max, next)));
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
      ref={asideRef}
      className="agent-sidebar"
      style={{ width, minWidth: width }}
      aria-label="sessions"
    >
      <SessionList
        rows={rows}
        onFocus={onFocus}
        style={{ height: topHeight, maxHeight: "none", flexShrink: 0 }}
      />
      <div
        className="agent-sidebar__divider is-draggable"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={startTopHeightDrag}
      />
      <div className="agent-sidebar__section is-bottom">
        <div className="agent-sidebar__label">Graph</div>
        <div className="agent-sidebar__graph-body">
          <GraphBody graph={graph} nowMs={nowMs} />
        </div>
      </div>
      <div className="agent-sidebar__footer">
        <MergeButton doneCount={doneCount} />
        {footerExtras}
      </div>
      <div
        className="agent-sidebar__width-handle"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startWidthDrag}
      />
    </aside>
  );
}

function GraphBody({ graph, nowMs }: { graph: SidebarGraph; nowMs: number }) {
  if (graph.state === "idle") {
    return <span className="agent-graph-empty">{graph.reason}</span>;
  }
  if (graph.state === "loading") {
    return <span className="agent-graph-empty">loading…</span>;
  }
  if (graph.state === "error") {
    return <span className="agent-graph-empty">{graph.message}</span>;
  }
  if (graph.layout.rows.length === 0) {
    return <span className="agent-graph-empty">no commits</span>;
  }
  return (
    <CommitGraph
      layout={graph.layout}
      headSha={graph.headSha}
      headRef={graph.headRef}
      nowMs={nowMs}
    />
  );
}
