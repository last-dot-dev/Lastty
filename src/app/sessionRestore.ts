import {
  createWorkspace,
  orderedPaneIds,
  type LayoutNode,
  type WorkspaceState,
} from "./layout";
import type { SessionInfo } from "../lib/ipc";

const STORAGE_KEY = "lastty.workspace.v1";
const PERSISTED_VERSION = 1;

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

export interface PersistedWorkspaceState {
  focusedPaneId: string | null;
  layout: LayoutNode;
  panes: PersistedPaneState[];
  savedAtMs: number;
  version: number;
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
  const paneIds = orderedPaneIds(workspace.layout);
  if (paneIds.length === 0) {
    return null;
  }

  const panes: PersistedPaneState[] = [];
  for (const paneId of paneIds) {
    const pane = workspace.panes[paneId];
    if (!pane) {
      return null;
    }
    const session = sessionInfoById[pane.sessionId];
    if (!session) {
      return null;
    }
    panes.push({
      cwd: session.cwd,
      paneId,
      serializedBuffer: snapshotsBySessionId[pane.sessionId]?.serializedBuffer ?? "",
      title: pane.title,
    });
  }

  return {
    focusedPaneId: workspace.focusedPaneId,
    layout: workspace.layout,
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
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PersistedWorkspaceState;
    if (
      parsed?.version !== PERSISTED_VERSION ||
      !Array.isArray(parsed.panes) ||
      typeof parsed.savedAtMs !== "number" ||
      !parsed.layout
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildRestoredWorkspaceState(
  persisted: PersistedWorkspaceState,
  sessions: SessionInfo[],
): RestoredWorkspaceState | null {
  if (persisted.panes.length === 0 || sessions.length !== persisted.panes.length) {
    return null;
  }

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
  const focusedPaneId =
    persisted.focusedPaneId && panes[persisted.focusedPaneId]
      ? persisted.focusedPaneId
      : persisted.panes[0]!.paneId;
  const workspace = {
    panes,
    layout: persisted.layout,
    focusedPaneId,
  };

  if (!workspaceIsValid(workspace)) {
    const firstPane = panes[persisted.panes[0]!.paneId];
    if (!firstPane) {
      return null;
    }
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
  const ordered = orderedPaneIds(workspace.layout);
  return ordered.length > 0 && ordered.every((paneId) => paneIds.has(paneId));
}
