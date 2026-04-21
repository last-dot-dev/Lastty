import { useEffect, useRef, useState, type ReactNode } from "react";

import WorktreeList, { type WorktreeRow } from "./WorktreeList";
import CommitGraph from "./CommitGraph";
import MergeButton from "./MergeButton";
import type { GraphLayout } from "../../lib/graphLayout";
import type { AgentDefinition } from "../../lib/ipc";

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
  rows,
  agents,
  projectRoot,
  onChangeProjectRoot,
  onFocusPane,
  onAttach,
  onMerge,
  mergeable,
  onOpenMergeDialog,
  footerExtras,
  graph,
  nowMs,
}: {
  rows: WorktreeRow[];
  agents: AgentDefinition[];
  projectRoot: string;
  onChangeProjectRoot: () => void;
  onFocusPane: (paneId: string) => void;
  onAttach: (worktreePath: string, choice: "shell" | { agentId: string }) => void;
  onMerge: (worktreePath: string) => void;
  mergeable: number;
  onOpenMergeDialog: () => void;
  footerExtras?: ReactNode;
  graph: SidebarGraph;
  nowMs: number;
}) {
  const [width, setWidth] = useState(() => loadNumber(WIDTH_KEY, 240, WIDTH_MIN, WIDTH_MAX));
  const [topHeight, setTopHeight] = useState(() =>
    loadNumber(TOP_HEIGHT_KEY, 240, TOP_MIN, 10_000),
  );
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
      aria-label="worktrees"
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
      <WorktreeList
        rows={rows}
        agents={agents}
        onFocusPane={onFocusPane}
        onAttach={onAttach}
        onMerge={onMerge}
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
        {mergeable > 0 && (
          <MergeButton
            count={mergeable}
            disabled={false}
            onClick={onOpenMergeDialog}
          />
        )}
        {footerExtras && (
          <div className="agent-sidebar__footer-row">
            {footerExtras}
          </div>
        )}
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
    return (
      <span className="agent-graph-empty">
        {graph.reason} — click <kbd>change</kbd> to pick a git repo
      </span>
    );
  }
  if (graph.state === "loading") {
    return <span className="agent-graph-empty">loading…</span>;
  }
  if (graph.state === "error") {
    return <span className="agent-graph-empty">{graph.message}</span>;
  }
  if (graph.layout.rows.length === 0) {
    return (
      <span className="agent-graph-empty">
        no commits — click <kbd>change</kbd> to pick a git repo
      </span>
    );
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
