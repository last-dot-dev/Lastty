import type { ReactNode } from "react";

import AlertBar, { type BlockedSessionRef } from "./AlertBar";
import Sidebar from "./Sidebar";
import DesktopStrip, { type DesktopEntry } from "./DesktopStrip";
import type { WorktreeRow } from "./WorktreeList";
import type { AgentDefinition } from "../../lib/ipc";
import UpdateBanner from "../UpdateBanner";

export default function AgentShell({
  blocked,
  onJumpToBlocked,
  worktreeRows,
  agents,
  projectRoot,
  onChangeProjectRoot,
  onFocusPane,
  onAttach,
  onMerge,
  onAbandon,
  onRename,
  mergeable,
  onOpenMergeDialog,
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
  worktreeRows: WorktreeRow[];
  agents: AgentDefinition[];
  projectRoot: string;
  onChangeProjectRoot: () => void;
  onFocusPane: (paneId: string) => void;
  onAttach: (worktreePath: string, choice: "shell" | { agentId: string }) => void;
  onMerge: (worktreePath: string) => void;
  onAbandon?: (worktreePath: string) => void;
  onRename?: (worktreePath: string, newBranch: string) => Promise<void>;
  mergeable: number;
  onOpenMergeDialog: () => void;
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
          rows={worktreeRows}
          agents={agents}
          projectRoot={projectRoot}
          onChangeProjectRoot={onChangeProjectRoot}
          onFocusPane={onFocusPane}
          onAttach={onAttach}
          onMerge={onMerge}
          onAbandon={onAbandon}
          onRename={onRename}
          mergeable={mergeable}
          onOpenMergeDialog={onOpenMergeDialog}
          footerExtras={sidebarFooterExtras}
          sessionsSlot={sidebarSessionsSlot}
          graphSlot={sidebarGraphSlot}
        />
        {children}
      </div>
    </>
  );
}
