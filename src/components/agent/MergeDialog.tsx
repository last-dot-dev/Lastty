import { useEffect, useMemo, useState } from "react";

import {
  createPullRequest,
  listGitBranches,
  type CreatePrResult,
  type GitBranch,
} from "../../lib/ipc";
import type { WorktreeRow } from "./WorktreeList";

type ResultState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: CreatePrResult }
  | { kind: "error"; message: string };

export default function MergeDialog({
  repoRoot,
  worktrees,
  focusWorktreePath,
  defaultSelectedPaths,
  onClose,
  onPrOpenedSuccess,
}: {
  repoRoot: string;
  worktrees: WorktreeRow[];
  focusWorktreePath: string | null;
  defaultSelectedPaths: Set<string>;
  onClose: () => void;
  onPrOpenedSuccess: (worktreePath: string, url: string) => void;
}) {
  const candidates = useMemo(
    () => worktrees.filter((w) => !w.isMain && !w.merged),
    [worktrees],
  );

  const [targetBranch, setTargetBranch] = useState<string>("");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchLoadError, setBranchLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (focusWorktreePath) return new Set([focusWorktreePath]);
    return new Set(
      Array.from(defaultSelectedPaths).filter((p) =>
        candidates.some((c) => c.path === p),
      ),
    );
  });
  const [commitMessage, setCommitMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [results, setResults] = useState<Record<string, ResultState>>({});

  useEffect(() => {
    let cancelled = false;
    void listGitBranches(repoRoot)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        const current = list.find((b) => b.is_current);
        if (current) setTargetBranch(current.name);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setBranchLoadError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function runCreatePrs() {
    if (!targetBranch) return;
    const order = candidates
      .filter((c) => selected.has(c.path))
      .map((c) => c.path);
    for (const path of order) {
      setResults((prev) => ({ ...prev, [path]: { kind: "running" } }));
      try {
        const result = await createPullRequest({
          worktree_path: path,
          target_branch: targetBranch,
          title: prTitle.trim() || null,
          body: prBody.trim() || null,
          auto_commit_message: commitMessage.trim() || null,
        });
        setResults((prev) => ({ ...prev, [path]: { kind: "done", result } }));
        onPrOpenedSuccess(path, result.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setResults((prev) => ({
          ...prev,
          [path]: { kind: "error", message },
        }));
      }
    }
  }

  const anySelected = candidates.some((c) => selected.has(c.path));
  const running = Object.values(results).some((r) => r.kind === "running");

  return (
    <div className="agent-merge-dialog-backdrop" onMouseDown={onClose}>
      <div
        className="agent-merge-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="agent-merge-dialog__header">
          <h2>Open pull requests</h2>
          <button
            type="button"
            className="agent-merge-dialog__close"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </div>
        <div className="agent-merge-dialog__body">
          <label className="agent-merge-dialog__field">
            <span>Target branch (PR base)</span>
            {branchLoadError ? (
              <span className="agent-merge-dialog__error">
                failed to list branches: {branchLoadError}
              </span>
            ) : (
              <select
                value={targetBranch}
                onChange={(event) => setTargetBranch(event.target.value)}
                disabled={running}
              >
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.is_current ? " (current)" : ""}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="agent-merge-dialog__field">
            <span>PR title (defaults to branch name)</span>
            <input
              type="text"
              value={prTitle}
              onChange={(event) => setPrTitle(event.target.value)}
              placeholder="leave empty to use branch name"
              disabled={running}
            />
          </label>
          <label className="agent-merge-dialog__field">
            <span>PR body (optional)</span>
            <input
              type="text"
              value={prBody}
              onChange={(event) => setPrBody(event.target.value)}
              placeholder="short summary"
              disabled={running}
            />
          </label>
          <label className="agent-merge-dialog__field">
            <span>Auto-commit message (if worktree has uncommitted diff)</span>
            <input
              type="text"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="agent work: <branch name>"
              disabled={running}
            />
          </label>
          <div className="agent-merge-dialog__candidates">
            <div className="agent-merge-dialog__label">Worktrees to open PRs for</div>
            {candidates.length === 0 && (
              <div className="agent-merge-dialog__empty">
                no worktrees available
              </div>
            )}
            {candidates.map((c) => {
              const result = results[c.path];
              return (
                <div key={c.path} className="agent-merge-dialog__row">
                  <label className="agent-merge-dialog__row-select">
                    <input
                      type="checkbox"
                      checked={selected.has(c.path)}
                      onChange={() => toggle(c.path)}
                      disabled={running}
                    />
                    <span className="agent-merge-dialog__row-name">
                      {c.branchName}
                    </span>
                    <span className="agent-merge-dialog__row-meta">
                      {c.uncommittedFiles} files · {c.unmergedCommits} ahead
                    </span>
                  </label>
                  {result && <PrResultView result={result} />}
                </div>
              );
            })}
          </div>
        </div>
        <div className="agent-merge-dialog__footer">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="agent-merge-dialog__btn"
          >
            close
          </button>
          <button
            type="button"
            onClick={() => void runCreatePrs()}
            disabled={!anySelected || !targetBranch || running}
            className="agent-merge-dialog__btn is-primary"
          >
            {running ? "opening…" : "open PRs"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PrResultView({ result }: { result: ResultState }) {
  if (result.kind === "idle") return null;
  if (result.kind === "running") {
    return <span className="agent-merge-dialog__status is-running">pushing + opening PR…</span>;
  }
  if (result.kind === "error") {
    return (
      <span className="agent-merge-dialog__status is-error">
        error: {result.message}
      </span>
    );
  }
  const { result: pr } = result;
  return (
    <span className="agent-merge-dialog__status is-ok">
      {pr.already_existed ? "✓ PR already open: " : "✓ PR opened: "}
      <a href={pr.url} target="_blank" rel="noreferrer">
        {pr.url}
      </a>
    </span>
  );
}
