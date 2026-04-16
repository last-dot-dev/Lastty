import type { ReactNode } from "react";

import AlertBar, { type BlockedSessionRef } from "./AlertBar";
import Sidebar from "./Sidebar";
import TabStrip, { type TabEntry } from "./TabStrip";
import type { BranchRow } from "./BranchList";

export default function AgentShell({
  blocked,
  onJumpToBlocked,
  branchRows,
  doneCount,
  onFocusBranch,
  tabs,
  onRestoreTab,
  sidebarFooterExtras,
  children,
}: {
  blocked: BlockedSessionRef[];
  onJumpToBlocked: (sessionId: string) => void;
  branchRows: BranchRow[];
  doneCount: number;
  onFocusBranch: (paneId: string) => void;
  tabs: TabEntry[];
  onRestoreTab: (paneId: string) => void;
  sidebarFooterExtras?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <AlertBar blocked={blocked} onJump={onJumpToBlocked} />
      <TabStrip tabs={tabs} onRestore={onRestoreTab} />
      <div className="agent-body">
        <Sidebar
          rows={branchRows}
          doneCount={doneCount}
          onFocus={onFocusBranch}
          footerExtras={sidebarFooterExtras}
        />
        {children}
      </div>
    </>
  );
}
