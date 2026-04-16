import type { ReactNode } from "react";

import AlertBar, { type BlockedSessionRef } from "./AlertBar";
import Sidebar from "./Sidebar";
import DesktopStrip, { type DesktopEntry } from "./DesktopStrip";
import type { BranchRow } from "./BranchList";

export default function AgentShell({
  blocked,
  onJumpToBlocked,
  branchRows,
  doneCount,
  onFocusBranch,
  desktops,
  activeDesktopId,
  onSwitchDesktop,
  onNewDesktop,
  onCloseDesktop,
  onRenameDesktop,
  onDropPaneOnDesktop,
  canAcceptPaneDrop,
  renderDesktopPreview,
  sidebarFooterExtras,
  children,
}: {
  blocked: BlockedSessionRef[];
  onJumpToBlocked: (sessionId: string) => void;
  branchRows: BranchRow[];
  doneCount: number;
  onFocusBranch: (paneId: string) => void;
  desktops: DesktopEntry[];
  activeDesktopId: string;
  onSwitchDesktop: (id: string) => void;
  onNewDesktop: () => void;
  onCloseDesktop: (id: string) => void;
  onRenameDesktop: (id: string, name: string) => void;
  onDropPaneOnDesktop?: (desktopId: string) => void;
  canAcceptPaneDrop?: boolean;
  renderDesktopPreview?: (desktopId: string) => ReactNode;
  sidebarFooterExtras?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <AlertBar blocked={blocked} onJump={onJumpToBlocked} />
      <DesktopStrip
        desktops={desktops}
        activeDesktopId={activeDesktopId}
        onSwitch={onSwitchDesktop}
        onNewDesktop={onNewDesktop}
        onCloseDesktop={onCloseDesktop}
        onRenameDesktop={onRenameDesktop}
        onDropPaneOnDesktop={onDropPaneOnDesktop}
        canAcceptPaneDrop={canAcceptPaneDrop}
        renderPreview={renderDesktopPreview}
      />
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
