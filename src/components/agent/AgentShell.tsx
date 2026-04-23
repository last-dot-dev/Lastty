import type { ReactNode } from "react";

import AlertBar, { type BlockedSessionRef } from "./AlertBar";
import Sidebar from "./Sidebar";
import DesktopStrip, { type DesktopEntry } from "./DesktopStrip";
import UpdateBanner from "../UpdateBanner";

export default function AgentShell({
  blocked,
  onJumpToBlocked,
  projectRoot,
  onChangeProjectRoot,
  desktops,
  activeDesktopId,
  onSwitchDesktop,
  onNewDesktop,
  onCloseDesktop,
  onRenameDesktop,
  onDropPaneOnDesktop,
  canAcceptPaneDrop,
  renderDesktopPreview,
  exposeMode,
  onToggleExpose,
  sidebarFooterExtras,
  sidebarSessionsSlot,
  sidebarGraphSlot,
  activeSessionCount,
  children,
}: {
  blocked: BlockedSessionRef[];
  onJumpToBlocked: (sessionId: string) => void;
  projectRoot: string;
  onChangeProjectRoot: () => void;
  desktops: DesktopEntry[];
  activeDesktopId: string;
  onSwitchDesktop: (id: string) => void;
  onNewDesktop: () => void;
  onCloseDesktop: (id: string) => void;
  onRenameDesktop: (id: string, name: string) => void;
  onDropPaneOnDesktop?: (desktopId: string) => void;
  canAcceptPaneDrop?: boolean;
  renderDesktopPreview?: (desktopId: string) => ReactNode;
  exposeMode: boolean;
  onToggleExpose: () => void;
  sidebarFooterExtras?: ReactNode;
  sidebarSessionsSlot: ReactNode;
  sidebarGraphSlot?: ReactNode;
  activeSessionCount: number;
  children: ReactNode;
}) {
  return (
    <>
      <UpdateBanner activeSessionCount={activeSessionCount} />
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
        exposeMode={exposeMode}
        onToggleExpose={onToggleExpose}
      />
      <div className="agent-body">
        <Sidebar
          projectRoot={projectRoot}
          onChangeProjectRoot={onChangeProjectRoot}
          footerExtras={sidebarFooterExtras}
          sessionsSlot={sidebarSessionsSlot}
          graphSlot={sidebarGraphSlot}
        />
        {children}
      </div>
    </>
  );
}
