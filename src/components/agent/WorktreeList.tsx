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
  style,
}: {
  rows: WorktreeRow[];
  agents: AgentDefinition[];
  onFocusPane: (paneId: string) => void;
  onAttach: (worktreePath: string, choice: "shell" | { agentId: string }) => void;
  onMerge: (worktreePath: string) => void;
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
}: {
  row: WorktreeRow;
  agents: AgentDefinition[];
  onFocusPane: (paneId: string) => void;
  onAttach: (worktreePath: string, choice: "shell" | { agentId: string }) => void;
  onMerge: (worktreePath: string) => void;
}) {
  const [attachOpen, setAttachOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!attachOpen) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setAttachOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
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
              <span>primary checkout</span>
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
            type="button"
            className="agent-worktree-row__action"
            onClick={(event) => {
              event.stopPropagation();
              setAttachOpen((prev) => !prev);
            }}
            title="attach a new pane to this worktree"
          >
            attach ▾
          </button>
          {attachOpen && (
            <div className="agent-worktree-row__attach-menu" role="menu">
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
      </div>
    </div>
  );
}
