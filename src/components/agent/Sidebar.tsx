import type { ReactNode } from "react";

import BranchList, { type BranchRow } from "./BranchList";
import MergeButton from "./MergeButton";

export default function Sidebar({
  rows,
  doneCount,
  onFocus,
  footerExtras,
}: {
  rows: BranchRow[];
  doneCount: number;
  onFocus: (paneId: string) => void;
  footerExtras?: ReactNode;
}) {
  return (
    <aside className="agent-sidebar" aria-label="sessions">
      <BranchList rows={rows} onFocus={onFocus} />
      <div className="agent-sidebar__divider" />
      <div className="agent-sidebar__section is-bottom">
        <div className="agent-sidebar__label">Graph</div>
        <div className="agent-sidebar__graph-body">
          <span className="agent-graph-placeholder">
            Commit graph needs a <code>git_graph</code> command from the backend — not
            wired yet. Branches above reflect active sessions.
          </span>
        </div>
      </div>
      <div className="agent-sidebar__footer">
        <MergeButton doneCount={doneCount} />
        {footerExtras}
      </div>
    </aside>
  );
}
