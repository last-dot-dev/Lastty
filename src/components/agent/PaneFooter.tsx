import { useEffect, useRef, useState } from "react";

import type { GitBranch } from "../../lib/ipc";

export default function PaneFooter({
  currentBranch,
  branches,
  isolated,
  onCheckout,
}: {
  currentBranch: string | null;
  branches: GitBranch[];
  isolated: boolean;
  onCheckout: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = currentBranch ?? "no repo";
  const disabled = currentBranch === null;

  return (
    <div className="agent-pane-footer" ref={ref}>
      <button
        type="button"
        className="agent-pane-footer__branch-btn"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        title={disabled ? "not a git repository" : "switch branch"}
      >
        {label}
        {!disabled && (
          <span className="agent-pane-footer__chevron" aria-hidden="true">
            ▾
          </span>
        )}
      </button>
      {isolated && <span className="agent-pane-footer__tag">isolated</span>}
      {open && !disabled && (
        <div className="agent-pane-footer__dropdown" role="listbox">
          {branches.length === 0 ? (
            <span className="agent-pane-footer__dropdown-empty">no branches</span>
          ) : (
            branches.map((branch) => {
              const claimedElsewhere =
                branch.worktree_path !== null && !branch.is_current;
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="option"
                  aria-selected={branch.is_current}
                  disabled={claimedElsewhere}
                  className={`agent-pane-footer__dropdown-item ${
                    branch.is_current ? "is-current" : ""
                  } ${claimedElsewhere ? "is-claimed" : ""}`}
                  title={
                    claimedElsewhere
                      ? `checked out in ${branch.worktree_path}`
                      : undefined
                  }
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (claimedElsewhere || branch.is_current) {
                      setOpen(false);
                      return;
                    }
                    setOpen(false);
                    onCheckout(branch.name);
                  }}
                >
                  <span className="agent-pane-footer__dropdown-mark" aria-hidden="true">
                    {branch.is_current ? "●" : ""}
                  </span>
                  {branch.name}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
