import { useEffect, useRef, useState, type ReactNode } from "react";

export interface DesktopEntry {
  id: string;
  name: string;
  projectLabel: string;
  paneCount: number;
  hasBlocked: boolean;
}

const PREVIEW_DELAY_MS = 400;
const DESKTOP_DRAG_MIME = "application/x-lastty-desktop-id";

type ReorderPlacement = "before" | "after";

export default function DesktopStrip({
  desktops,
  activeDesktopId,
  onSwitch,
  onNewDesktop,
  onCloseDesktop,
  onRenameDesktop,
  onDropPaneOnDesktop,
  onReorderDesktops,
  canAcceptPaneDrop,
  renderPreview,
  exposeMode,
  onToggleExpose,
}: {
  desktops: DesktopEntry[];
  activeDesktopId: string;
  onSwitch: (id: string) => void;
  onNewDesktop: () => void;
  onCloseDesktop: (id: string) => void;
  onRenameDesktop: (id: string, name: string) => void;
  onDropPaneOnDesktop?: (desktopId: string) => void;
  onReorderDesktops?: (
    draggedId: string,
    targetId: string,
    placement: ReorderPlacement,
  ) => void;
  canAcceptPaneDrop?: boolean;
  renderPreview?: (desktopId: string) => ReactNode;
  exposeMode: boolean;
  onToggleExpose: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [reorderOver, setReorderOver] = useState<
    { id: string; placement: ReorderPlacement } | null
  >(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
  }, []);

  const commit = (id: string) => {
    const trimmed = draftName.trim();
    if (trimmed) onRenameDesktop(id, trimmed);
    setEditingId(null);
    setDraftName("");
  };

  const scheduleHover = (id: string, el: HTMLDivElement) => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      const rect = el.getBoundingClientRect();
      setHoveredId(id);
      setHoverAnchor({ left: rect.left, top: rect.bottom + 4 });
    }, PREVIEW_DELAY_MS);
  };

  const cancelHover = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredId(null);
    setHoverAnchor(null);
  };

  return (
    <div
      className="agent-desktop-strip"
      role="tablist"
      aria-label="views"
      data-tauri-drag-region
    >
      {desktops.map((desktop) => {
        const active = desktop.id === activeDesktopId;
        const isEditing = editingId === desktop.id;
        const isDropTarget = dropTargetId === desktop.id;
        const insertBefore = reorderOver?.id === desktop.id && reorderOver.placement === "before";
        const insertAfter = reorderOver?.id === desktop.id && reorderOver.placement === "after";
        return (
          <div
            key={desktop.id}
            role="tab"
            aria-selected={active}
            draggable={!isEditing}
            className={`agent-desktop-tab ${active ? "is-active" : ""} ${
              desktop.hasBlocked ? "is-needs-help" : ""
            } ${isDropTarget ? "is-drop-target" : ""} ${
              insertBefore ? "is-insert-before" : ""
            } ${insertAfter ? "is-insert-after" : ""}`}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onCloseDesktop(desktop.id);
              }
            }}
            onMouseEnter={(event) => scheduleHover(desktop.id, event.currentTarget)}
            onMouseLeave={cancelHover}
            onClick={() => {
              if (!isEditing) onSwitch(desktop.id);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditingId(desktop.id);
              setDraftName(desktop.name);
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData(DESKTOP_DRAG_MIME, desktop.id);
              event.dataTransfer.effectAllowed = "move";
              cancelHover();
            }}
            onDragEnd={() => setReorderOver(null)}
            onDragEnter={(event) => {
              if (event.dataTransfer.types.includes(DESKTOP_DRAG_MIME)) {
                event.preventDefault();
                return;
              }
              if (!canAcceptPaneDrop) return;
              event.preventDefault();
              setDropTargetId(desktop.id);
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(DESKTOP_DRAG_MIME)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const placement: ReorderPlacement =
                  event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                setReorderOver((current) =>
                  current?.id === desktop.id && current.placement === placement
                    ? current
                    : { id: desktop.id, placement },
                );
                return;
              }
              if (!canAcceptPaneDrop) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDragLeave={(event) => {
              if (event.currentTarget !== event.target) return;
              setDropTargetId((current) => (current === desktop.id ? null : current));
              setReorderOver((current) => (current?.id === desktop.id ? null : current));
            }}
            onDrop={(event) => {
              const draggedId = event.dataTransfer.getData(DESKTOP_DRAG_MIME);
              if (draggedId) {
                event.preventDefault();
                const placement = reorderOver?.placement ?? "after";
                setReorderOver(null);
                cancelHover();
                onReorderDesktops?.(draggedId, desktop.id, placement);
                return;
              }
              if (!canAcceptPaneDrop) return;
              event.preventDefault();
              setDropTargetId(null);
              cancelHover();
              onDropPaneOnDesktop?.(desktop.id);
            }}
            title={`${desktop.name}${desktop.projectLabel ? ` (${desktop.projectLabel})` : ""} · ${desktop.paneCount} pane${desktop.paneCount === 1 ? "" : "s"}`}
          >
            {desktop.hasBlocked && <span className="agent-desktop-tab__dot" aria-hidden />}
            {isEditing ? (
              <input
                ref={inputRef}
                className="agent-desktop-tab__input"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => commit(desktop.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commit(desktop.id);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setEditingId(null);
                    setDraftName("");
                  }
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <>
                <span className="agent-desktop-tab__name">{desktop.name}</span>
                {desktop.projectLabel && (
                  <span className="agent-desktop-tab__project">{desktop.projectLabel}</span>
                )}
              </>
            )}
            <span className="agent-desktop-tab__count">{desktop.paneCount}</span>
            {desktops.length > 1 && !isEditing && (
              <button
                type="button"
                className="agent-desktop-tab__close"
                aria-label={`close ${desktop.name}`}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseDesktop(desktop.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="agent-desktop-strip__new"
        onClick={onNewDesktop}
        title="New view"
        aria-label="new view"
      >
        +
      </button>
      <div className="agent-desktop-strip__spacer" data-tauri-drag-region />
      <button
        type="button"
        className={`agent-desktop-strip__overview ${exposeMode ? "is-active" : ""}`}
        onClick={onToggleExpose}
        title="Overview (\\)"
        aria-label="Toggle overview"
        aria-pressed={exposeMode}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
          <rect x="1" y="1" width="4" height="4" />
          <rect x="7" y="1" width="4" height="4" />
          <rect x="1" y="7" width="4" height="4" />
          <rect x="7" y="7" width="4" height="4" />
        </svg>
      </button>
      {hoveredId && hoverAnchor && renderPreview && (
        <div
          className="agent-desktop-preview-anchor"
          style={{
            position: "fixed",
            left: Math.max(8, Math.min(hoverAnchor.left, window.innerWidth - 260)),
            top: hoverAnchor.top,
            zIndex: 60,
            pointerEvents: "none",
          }}
        >
          {renderPreview(hoveredId)}
        </div>
      )}
    </div>
  );
}
