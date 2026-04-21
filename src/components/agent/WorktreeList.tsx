import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { AgentDefinition, ChangedFile } from "../../lib/ipc";

export interface WorktreeRow {
  path: string;
  branchName: string;
  isLastty: boolean;
  isMain: boolean;
  uncommittedFiles: number;
  unmergedCommits: number;
  changedFiles: ChangedFile[];
  liveSessions: number;
  firstLivePaneId: string | null;
  merged: boolean;
}

const STATUS_GLYPH: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  ignored: "!",
  type_change: "T",
  conflicted: "U",
  other: "·",
};

export default function WorktreeList({
  rows,
  agents,
  onFocusPane,
  onAttach,
  onMerge,
  onAbandon,
  style,
}: {
  rows: WorktreeRow[];
  agents: AgentDefinition[];
  onFocusPane: (paneId: string) => void;
  onAttach: (worktreePath: string, choice: "shell" | { agentId: string }) => void;
  onMerge: (worktreePath: string) => void;
  onAbandon?: (worktreePath: string) => void;
  style?: CSSProperties;
}) {
  return (
    <div className="agent-sidebar__section is-top" style={style}>
      <div className="agent-sidebar__label">Worktrees</div>
      <div className="agent-sidebar__worktrees">
        {rows.length === 0 && (
          <div className="agent-worktree-empty">no worktrees yet</div>
        )}
        {rows.map((row) => (
          <WorktreeRowView
            key={row.path}
            row={row}
            agents={agents}
            onFocusPane={onFocusPane}
            onAttach={onAttach}
            onMerge={onMerge}
            onAbandon={onAbandon}
          />
        ))}
      </div>
    </div>
  );
}

function WorktreeRowView({
  row,
  agents,
  onFocusPane,
  onAttach,
  onMerge,
  onAbandon,
}: {
  row: WorktreeRow;
  agents: AgentDefinition[];
  onFocusPane: (paneId: string) => void;
  onAttach: (worktreePath: string, choice: "shell" | { agentId: string }) => void;
  onMerge: (worktreePath: string) => void;
  onAbandon?: (worktreePath: string) => void;
}) {
  const [attachOpen, setAttachOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!attachOpen) return;
    const close = () => setAttachOpen(false);
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideRow = ref.current?.contains(target);
      const insideMenu = menuRef.current?.contains(target);
      if (!insideRow && !insideMenu) close();
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [attachOpen]);

  const live = row.liveSessions > 0;
  const dot = row.merged ? "✓" : live ? "●" : "○";
  const onRowClick = () => {
    if (live && row.firstLivePaneId) {
      onFocusPane(row.firstLivePaneId);
    }
  };

  return (
    <div
      ref={ref}
      className={`agent-worktree-row ${live ? "is-live" : "is-dormant"} ${
        row.merged ? "is-merged" : ""
      } ${row.isMain ? "is-main" : ""}`}
    >
      <button
        type="button"
        className="agent-worktree-row__body"
        onClick={onRowClick}
      >
        <span
          className={`agent-worktree-row__dot ${
            row.merged ? "is-merged" : live ? "is-live" : "is-dormant"
          }`}
          aria-hidden="true"
        >
          {dot}
        </span>
        <span className="agent-worktree-row__content">
          <span className="agent-worktree-row__name">
            {row.branchName || "(detached)"}
          </span>
          <span className="agent-worktree-row__meta">
            {row.isMain ? (
              <>
                <span>primary checkout</span>
                {row.liveSessions > 0 && (
                  <span title="agents running in-place on main">
                    {row.liveSessions} live
                  </span>
                )}
              </>
            ) : (
              <>
                {row.uncommittedFiles > 0 && (
                  <span>{row.uncommittedFiles} files</span>
                )}
                {row.unmergedCommits > 0 && (
                  <span>{row.unmergedCommits} ahead</span>
                )}
                {row.isLastty && <span className="agent-worktree-row__tag">lastty</span>}
              </>
            )}
          </span>
        </span>
      </button>
      {row.changedFiles.length > 0 && (
        <ul className="agent-worktree-row__files">
          {row.changedFiles.map((file) => (
            <li
              key={`${file.status}:${file.path}`}
              className={`agent-worktree-row__file is-${file.status}`}
              title={`${file.status} · ${file.path}`}
            >
              <span className="agent-worktree-row__file-glyph" aria-hidden="true">
                {STATUS_GLYPH[file.status] ?? "·"}
              </span>
              <span className="agent-worktree-row__file-path">{file.path}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="agent-worktree-row__actions">
        <div className="agent-worktree-row__attach-wrap">
          <button
            ref={buttonRef}
            type="button"
            className="agent-worktree-row__action"
            onClick={(event) => {
              event.stopPropagation();
              if (attachOpen) {
                setAttachOpen(false);
                return;
              }
              const rect = buttonRef.current?.getBoundingClientRect();
              if (rect) {
                setMenuPos({ left: rect.left, top: rect.bottom + 4 });
              }
              setAttachOpen(true);
            }}
            title="attach a new pane to this worktree"
          >
            attach ▾
          </button>
          {attachOpen && menuPos && (
            <div
              ref={menuRef}
              className="agent-worktree-row__attach-menu"
              role="menu"
              style={{ left: menuPos.left, top: menuPos.top }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAttachOpen(false);
                  onAttach(row.path, "shell");
                }}
              >
                shell
              </button>
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachOpen(false);
                    onAttach(row.path, { agentId: agent.id });
                  }}
                >
                  {agent.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {!row.isMain && (
          <button
            type="button"
            className="agent-worktree-row__action"
            onClick={(event) => {
              event.stopPropagation();
              onMerge(row.path);
            }}
            title="push this branch and open a pull request"
            disabled={row.merged}
          >
            open PR
          </button>
        )}
        {!row.isMain && onAbandon && (
          <button
            type="button"
            className="agent-worktree-row__action"
            onClick={(event) => {
              event.stopPropagation();
              onAbandon(row.path);
            }}
            title="close PR (if any), delete remote + local branch, remove worktree"
            aria-label={`abandon ${row.branchName}`}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
