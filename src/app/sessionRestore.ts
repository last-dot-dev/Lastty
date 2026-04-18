import {
  createDesktopState,
  createWorkspace,
  orderedPaneIds,
  type DesktopState,
  type LayoutNode,
  type WorkspaceState,
} from "./layout";
import type { SessionInfo } from "../lib/ipc";

const STORAGE_KEY = "lastty.workspace.v1";
const PERSISTED_VERSION = 2;

export interface PersistedTerminalSnapshot {
  capturedAtMs: number;
  cols: number;
  rows: number;
  serializedBuffer: string;
}

export interface PersistedPaneState {
  cwd: string;
  paneId: string;
  serializedBuffer: string;
  title: string;
}

export interface PersistedDesktop {
  id: string;
  name: string;
  layout: LayoutNode | null;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
}

export interface PersistedWorkspaceState {
  activeDesktopId: string;
  desktops: PersistedDesktop[];
  panes: PersistedPaneState[];
  savedAtMs: number;
  version: number;
}

interface PersistedWorkspaceStateV1 {
  focusedPaneId: string | null;
  layout: LayoutNode;
  panes: PersistedPaneState[];
  savedAtMs: number;
  version: 1;
}

export interface RestoredWorkspaceState {
  restoredSnapshotsBySessionId: Record<string, PersistedTerminalSnapshot>;
  workspace: WorkspaceState;
}

export function buildPersistedWorkspaceState(
  workspace: WorkspaceState,
  sessionInfoById: Record<string, SessionInfo>,
  snapshotsBySessionId: Record<string, PersistedTerminalSnapshot>,
): PersistedWorkspaceState | null {
  if (workspace.desktops.length === 0) return null;

  const panes: PersistedPaneState[] = [];
  const desktops: PersistedDesktop[] = [];

  for (const desktop of workspace.desktops) {
    const paneIds = desktop.layout ? orderedPaneIds(desktop.layout) : [];
    for (const paneId of paneIds) {
      const pane = workspace.panes[paneId];
      if (!pane) return null;
      const session = sessionInfoById[pane.sessionId];
      if (!session) return null;
      if (!session.cwd) return null;
      panes.push({
        cwd: session.cwd,
        paneId,
        serializedBuffer: snapshotsBySessionId[pane.sessionId]?.serializedBuffer ?? "",
        title: pane.title,
      });
    }
    desktops.push({
      id: desktop.id,
      name: desktop.name,
      layout: desktop.layout,
      focusedPaneId: desktop.focusedPaneId,
      maximizedPaneId: desktop.maximizedPaneId,
    });
  }

  if (panes.length === 0) return null;

  return {
    activeDesktopId: workspace.activeDesktopId,
    desktops,
    panes,
    savedAtMs: Date.now(),
    version: PERSISTED_VERSION,
  };
}

export function persistWorkspaceState(
  state: PersistedWorkspaceState,
  storage: Pick<Storage, "setItem"> = window.localStorage,
) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function readPersistedWorkspaceState(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): PersistedWorkspaceState | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as
      | PersistedWorkspaceState
      | PersistedWorkspaceStateV1
      | null;
    if (!parsed || typeof parsed.savedAtMs !== "number" || !Array.isArray(parsed.panes)) {
      return null;
    }

    if (parsed.version === 1) {
      return migrateV1(parsed as PersistedWorkspaceStateV1);
    }

    if (
      parsed.version !== PERSISTED_VERSION ||
      !Array.isArray((parsed as PersistedWorkspaceState).desktops) ||
      typeof (parsed as PersistedWorkspaceState).activeDesktopId !== "string"
    ) {
      return null;
    }

    return parsed as PersistedWorkspaceState;
  } catch {
    return null;
  }
}

function migrateV1(v1: PersistedWorkspaceStateV1): PersistedWorkspaceState | null {
  if (!v1.layout) return null;
  const desktopId = "desktop-legacy-1";
  return {
    activeDesktopId: desktopId,
    desktops: [
      {
        id: desktopId,
        name: "View 1",
        layout: v1.layout,
        focusedPaneId: v1.focusedPaneId,
        maximizedPaneId: null,
      },
    ],
    panes: v1.panes,
    savedAtMs: v1.savedAtMs,
    version: PERSISTED_VERSION,
  };
}

export function buildRestoredWorkspaceState(
  persisted: PersistedWorkspaceState,
  sessions: SessionInfo[],
): RestoredWorkspaceState | null {
  if (persisted.panes.length === 0 || sessions.length !== persisted.panes.length) {
    return null;
  }

  const sessionByPaneId: Record<string, SessionInfo> = {};
  persisted.panes.forEach((pane, index) => {
    sessionByPaneId[pane.paneId] = sessions[index]!;
  });

  const panes = Object.fromEntries(
    persisted.panes.map((pane, index) => [
      pane.paneId,
      {
        id: pane.paneId,
        sessionId: sessions[index]!.session_id,
        title: pane.title || sessions[index]!.title,
      },
    ]),
  );

  const desktops: DesktopState[] = persisted.desktops.map((desktop) => {
    const paneIds = desktop.layout ? orderedPaneIds(desktop.layout) : [];
    const validPaneIds = paneIds.filter((paneId) => paneId in panes);
    const layout =
      desktop.layout && validPaneIds.length === paneIds.length ? desktop.layout : null;
    const focusedPaneId =
      desktop.focusedPaneId && validPaneIds.includes(desktop.focusedPaneId)
        ? desktop.focusedPaneId
        : validPaneIds[0] ?? null;
    const maximizedPaneId =
      desktop.maximizedPaneId && validPaneIds.includes(desktop.maximizedPaneId)
        ? desktop.maximizedPaneId
        : null;
    return {
      id: desktop.id,
      name: desktop.name,
      layout,
      focusedPaneId,
      maximizedPaneId,
    };
  });

  const nonEmptyDesktops = desktops.some((desktop) => desktop.layout !== null);
  if (!nonEmptyDesktops) {
    const firstPaneId = persisted.panes[0]!.paneId;
    const firstPane = panes[firstPaneId];
    if (!firstPane) return null;
    return {
      workspace: createWorkspace(firstPane),
      restoredSnapshotsBySessionId: buildRestoredSnapshots(persisted, sessions),
    };
  }

  const activeDesktopId = desktops.some((desktop) => desktop.id === persisted.activeDesktopId)
    ? persisted.activeDesktopId
    : desktops[0]!.id;

  const workspace: WorkspaceState = {
    panes,
    desktops: desktops.length > 0 ? desktops : [createDesktopState(null, "Desktop 1")],
    activeDesktopId,
  };

  if (!workspaceIsValid(workspace)) {
    const firstPaneId = persisted.panes[0]!.paneId;
    const firstPane = panes[firstPaneId];
    if (!firstPane) return null;
    return {
      workspace: createWorkspace(firstPane),
      restoredSnapshotsBySessionId: buildRestoredSnapshots(persisted, sessions),
    };
  }

  return {
    workspace,
    restoredSnapshotsBySessionId: buildRestoredSnapshots(persisted, sessions),
  };
}

function buildRestoredSnapshots(
  persisted: PersistedWorkspaceState,
  sessions: SessionInfo[],
): Record<string, PersistedTerminalSnapshot> {
  return Object.fromEntries(
    persisted.panes.map((pane, index) => [
      sessions[index]!.session_id,
      {
        capturedAtMs: persisted.savedAtMs,
        cols: 80,
        rows: 24,
        serializedBuffer: pane.serializedBuffer,
      },
    ]),
  );
}

function workspaceIsValid(workspace: WorkspaceState) {
  const paneIds = new Set(Object.keys(workspace.panes));
  if (workspace.desktops.length === 0) return false;
  const seen = new Set<string>();
  for (const desktop of workspace.desktops) {
    if (!desktop.layout) continue;
    const ordered = orderedPaneIds(desktop.layout);
    for (const paneId of ordered) {
      if (!paneIds.has(paneId)) return false;
      if (seen.has(paneId)) return false;
      seen.add(paneId);
    }
  }
  return true;
}
