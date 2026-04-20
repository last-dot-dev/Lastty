import type { ReactNode } from "react";

import AlertBar, { type BlockedSessionRef } from "./AlertBar";
import Sidebar, { type SidebarGraph } from "./Sidebar";
import DesktopStrip, { type DesktopEntry } from "./DesktopStrip";
import type { SessionRow } from "./SessionList";

export default function AgentShell({
  blocked,
  onJumpToBlocked,
  sessionRows,
  doneCount,
  onFocusSession,
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
  sidebarGraph,
  nowMs,
  children,
}: {
  blocked: BlockedSessionRef[];
  onJumpToBlocked: (sessionId: string) => void;
  sessionRows: SessionRow[];
  doneCount: number;
  onFocusSession: (paneId: string) => void;
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
  sidebarGraph: SidebarGraph;
  nowMs: number;
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
          rows={sessionRows}
          doneCount={doneCount}
          onFocus={onFocusSession}
          footerExtras={sidebarFooterExtras}
          graph={sidebarGraph}
          nowMs={nowMs}
        />
        {children}
      </div>
    </>
  );
}
