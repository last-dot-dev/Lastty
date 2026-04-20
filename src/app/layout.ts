export type SplitDirection = "horizontal" | "vertical";
export type LayoutPath = number[];
export type FocusDirection = "left" | "right" | "up" | "down";

export interface PaneRecord {
  id: string;
  sessionId: string;
  title: string;
}

export type LayoutNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      direction: SplitDirection;
      children: LayoutNode[];
      weights: number[];
    };

export interface DesktopState {
  id: string;
  name: string;
  projectRoot: string;
  layout: LayoutNode | null;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
}

export interface WorkspaceState {
  panes: Record<string, PaneRecord>;
  desktops: DesktopState[];
  activeDesktopId: string;
}

export interface CloseDesktopResult {
  workspace: WorkspaceState;
  removedSessionIds: string[];
}

let desktopCounter = 0;

function nextDesktopId(): string {
  desktopCounter += 1;
  return `desktop-${Date.now().toString(36)}-${desktopCounter}`;
}

export function createPaneRecord(sessionId: string, title = "shell"): PaneRecord {
  return {
    id: `pane-${sessionId}`,
    sessionId,
    title,
  };
}

export function createDesktopState(
  rootPane: PaneRecord | null,
  name: string,
  projectRoot: string,
  id: string = nextDesktopId(),
): DesktopState {
  return {
    id,
    name,
    projectRoot,
    layout: rootPane ? { type: "leaf", paneId: rootPane.id } : null,
    focusedPaneId: rootPane?.id ?? null,
    maximizedPaneId: null,
  };
}

export function createWorkspace(
  rootPane: PaneRecord,
  projectRoot: string,
): WorkspaceState {
  const desktop = createDesktopState(rootPane, "View 1", projectRoot);
  return {
    panes: { [rootPane.id]: rootPane },
    desktops: [desktop],
    activeDesktopId: desktop.id,
  };
}

export function activeDesktop(state: WorkspaceState): DesktopState {
  const desktop = state.desktops.find((entry) => entry.id === state.activeDesktopId);
  return desktop ?? state.desktops[0]!;
}

export function findDesktopForPane(
  state: WorkspaceState,
  paneId: string,
): DesktopState | null {
  return (
    state.desktops.find((desktop) =>
      desktop.layout ? orderedPaneIds(desktop.layout).includes(paneId) : false,
    ) ?? null
  );
}

function updateDesktop(
  state: WorkspaceState,
  desktopId: string,
  updater: (desktop: DesktopState) => DesktopState,
): WorkspaceState {
  const desktops = state.desktops.map((desktop) =>
    desktop.id === desktopId ? updater(desktop) : desktop,
  );
  return { ...state, desktops };
}

export function focusPane(
  state: WorkspaceState,
  paneId: string,
  desktopId: string = state.activeDesktopId,
): WorkspaceState {
  if (!(paneId in state.panes)) return state;
  const desktop = state.desktops.find((entry) => entry.id === desktopId);
  if (!desktop) return state;
  if (desktop.focusedPaneId === paneId) return state;
  if (!desktop.layout || !orderedPaneIds(desktop.layout).includes(paneId)) return state;
  return updateDesktop(state, desktopId, (entry) => ({ ...entry, focusedPaneId: paneId }));
}

export function focusAdjacentPane(
  state: WorkspaceState,
  direction: FocusDirection,
  desktopId: string = state.activeDesktopId,
): WorkspaceState {
  const desktop = state.desktops.find((entry) => entry.id === desktopId);
  if (!desktop || !desktop.layout || !desktop.focusedPaneId) return state;
  const nextPaneId = findAdjacentPaneId(desktop.layout, desktop.focusedPaneId, direction);
  return nextPaneId ? focusPane(state, nextPaneId, desktopId) : state;
}

export function renamePane(
  state: WorkspaceState,
  sessionId: string,
  title: string,
): WorkspaceState {
  const pane = Object.values(state.panes).find((entry) => entry.sessionId === sessionId);
  if (!pane) return state;
  return {
    ...state,
    panes: {
      ...state.panes,
      [pane.id]: { ...pane, title },
    },
  };
}

export function splitPane(
  state: WorkspaceState,
  paneId: string,
  direction: SplitDirection,
  nextPane: PaneRecord,
  desktopId: string = state.activeDesktopId,
): WorkspaceState {
  if (!(paneId in state.panes)) return state;
  const desktop = state.desktops.find((entry) => entry.id === desktopId);
  if (!desktop || !desktop.layout) return state;
  if (!orderedPaneIds(desktop.layout).includes(paneId)) return state;

  const layout = replaceLeaf(desktop.layout, paneId, {
    type: "split",
    direction,
    children: [
      { type: "leaf", paneId },
      { type: "leaf", paneId: nextPane.id },
    ],
    weights: [1, 1],
  });

  return {
    ...state,
    panes: { ...state.panes, [nextPane.id]: nextPane },
    desktops: state.desktops.map((entry) =>
      entry.id === desktopId
        ? { ...entry, layout, focusedPaneId: nextPane.id }
        : entry,
    ),
  };
}

export function resizeSplit(
  state: WorkspaceState,
  path: LayoutPath,
  handleIndex: number,
  delta: number,
  baseWeights?: number[],
  desktopId: string = state.activeDesktopId,
): WorkspaceState {
  const desktop = state.desktops.find((entry) => entry.id === desktopId);
  if (!desktop || !desktop.layout) return state;

  const layout = updateSplitAtPath(desktop.layout, path, (node) => {
    const sourceWeights =
      baseWeights && baseWeights.length === node.weights.length ? baseWeights : node.weights;
    const nextWeights = resizeSplitWeights(sourceWeights, handleIndex, delta);
    if (
      nextWeights.length === node.weights.length &&
      nextWeights.every((weight, index) => weight === node.weights[index])
    ) {
      return node;
    }
    return { ...node, weights: nextWeights };
  });

  if (layout === desktop.layout) return state;
  return updateDesktop(state, desktopId, (entry) => ({ ...entry, layout }));
}

export function closePane(
  state: WorkspaceState,
  paneId: string,
  desktopId: string = state.activeDesktopId,
): WorkspaceState {
  if (!(paneId in state.panes)) return state;
  const desktop = state.desktops.find((entry) => entry.id === desktopId);
  if (!desktop || !desktop.layout) return state;
  if (!orderedPaneIds(desktop.layout).includes(paneId)) return state;

  const layout = removeLeaf(desktop.layout, paneId);
  const ordered = layout ? orderedPaneIds(layout) : [];

  const panes = { ...state.panes };
  delete panes[paneId];

  return {
    ...state,
    panes,
    desktops: state.desktops.map((entry) =>
      entry.id === desktopId
        ? {
            ...entry,
            layout,
            focusedPaneId: ordered.includes(entry.focusedPaneId ?? "")
              ? entry.focusedPaneId
              : ordered[0] ?? null,
            maximizedPaneId:
              entry.maximizedPaneId && ordered.includes(entry.maximizedPaneId)
                ? entry.maximizedPaneId
                : null,
          }
        : entry,
    ),
  };
}

export function toggleMaximize(
  state: WorkspaceState,
  paneId: string,
  desktopId: string = state.activeDesktopId,
): WorkspaceState {
  return updateDesktop(state, desktopId, (desktop) =>
    desktop.layout && orderedPaneIds(desktop.layout).includes(paneId)
      ? {
          ...desktop,
          maximizedPaneId: desktop.maximizedPaneId === paneId ? null : paneId,
        }
      : desktop,
  );
}

export function detachPane(state: WorkspaceState, paneId: string): WorkspaceState {
  const desktop = findDesktopForPane(state, paneId);
  if (!desktop || !desktop.layout) return state;
  const layout = removeLeaf(desktop.layout, paneId);
  const ordered = layout ? orderedPaneIds(layout) : [];
  return {
    ...state,
    desktops: state.desktops.map((entry) =>
      entry.id === desktop.id
        ? {
            ...entry,
            layout,
            focusedPaneId: ordered.includes(entry.focusedPaneId ?? "")
              ? entry.focusedPaneId
              : ordered[0] ?? null,
            maximizedPaneId:
              entry.maximizedPaneId && ordered.includes(entry.maximizedPaneId)
                ? entry.maximizedPaneId
                : null,
          }
        : entry,
    ),
  };
}

export function attachPaneToDesktop(
  state: WorkspaceState,
  paneId: string,
  desktopId: string,
): WorkspaceState {
  if (!(paneId in state.panes)) return state;
  const desktop = state.desktops.find((entry) => entry.id === desktopId);
  if (!desktop) return state;
  if (desktop.layout && orderedPaneIds(desktop.layout).includes(paneId)) return state;

  const leaf: LayoutNode = { type: "leaf", paneId };
  const layout: LayoutNode = desktop.layout
    ? {
        type: "split",
        direction: "horizontal",
        children: [desktop.layout, leaf],
        weights: [1, 1],
      }
    : leaf;

  return updateDesktop(state, desktopId, (entry) => ({
    ...entry,
    layout,
    focusedPaneId: paneId,
  }));
}

export type SplitSide = "left" | "right" | "top" | "bottom";

export function splitAtPane(
  state: WorkspaceState,
  targetPaneId: string,
  sourcePaneId: string,
  side: SplitSide,
): WorkspaceState {
  if (targetPaneId === sourcePaneId) return state;
  if (!(sourcePaneId in state.panes) || !(targetPaneId in state.panes)) return state;
  const targetDesktop = findDesktopForPane(state, targetPaneId);
  if (!targetDesktop || !targetDesktop.layout) return state;

  const direction: SplitDirection =
    side === "left" || side === "right" ? "horizontal" : "vertical";
  const sourceFirst = side === "left" || side === "top";

  const replacement: LayoutNode = {
    type: "split",
    direction,
    children: sourceFirst
      ? [
          { type: "leaf", paneId: sourcePaneId },
          { type: "leaf", paneId: targetPaneId },
        ]
      : [
          { type: "leaf", paneId: targetPaneId },
          { type: "leaf", paneId: sourcePaneId },
        ],
    weights: [1, 1],
  };

  const detached = detachPane(state, sourcePaneId);
  const desktopAfterDetach = detached.desktops.find((entry) => entry.id === targetDesktop.id);
  if (!desktopAfterDetach || !desktopAfterDetach.layout) return state;
  if (!orderedPaneIds(desktopAfterDetach.layout).includes(targetPaneId)) return state;

  const layout = replaceLeaf(desktopAfterDetach.layout, targetPaneId, replacement);
  return updateDesktop(detached, targetDesktop.id, (entry) => ({
    ...entry,
    layout,
    focusedPaneId: sourcePaneId,
  }));
}

export function swapPanes(
  state: WorkspaceState,
  paneA: string,
  paneB: string,
): WorkspaceState {
  if (paneA === paneB) return state;
  if (!(paneA in state.panes) || !(paneB in state.panes)) return state;
  const desktopA = findDesktopForPane(state, paneA);
  const desktopB = findDesktopForPane(state, paneB);
  if (!desktopA || !desktopB || !desktopA.layout || !desktopB.layout) return state;

  return {
    ...state,
    desktops: state.desktops.map((entry) => {
      if (entry.id === desktopA.id && entry.id === desktopB.id) {
        const layout = swapLeaves(entry.layout!, paneA, paneB);
        return { ...entry, layout };
      }
      if (entry.id === desktopA.id) {
        const layout = replaceLeaf(entry.layout!, paneA, { type: "leaf", paneId: paneB });
        return {
          ...entry,
          layout,
          focusedPaneId: entry.focusedPaneId === paneA ? paneB : entry.focusedPaneId,
        };
      }
      if (entry.id === desktopB.id) {
        const layout = replaceLeaf(entry.layout!, paneB, { type: "leaf", paneId: paneA });
        return {
          ...entry,
          layout,
          focusedPaneId: entry.focusedPaneId === paneB ? paneA : entry.focusedPaneId,
        };
      }
      return entry;
    }),
  };
}

function swapLeaves(node: LayoutNode, a: string, b: string): LayoutNode {
  if (node.type === "leaf") {
    if (node.paneId === a) return { type: "leaf", paneId: b };
    if (node.paneId === b) return { type: "leaf", paneId: a };
    return node;
  }
  return {
    ...node,
    children: node.children.map((child) => swapLeaves(child, a, b)),
  };
}

function nextDefaultDesktopName(desktops: DesktopState[]): string {
  const pattern = /^View (\d+)$/;
  const maxN = desktops.reduce((acc, d) => {
    const m = pattern.exec(d.name);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `View ${maxN + 1}`;
}

export function createDesktop(
  state: WorkspaceState,
  rootPane: PaneRecord,
  projectRoot: string,
  name?: string,
): WorkspaceState {
  const desktopName = name || nextDefaultDesktopName(state.desktops);
  const desktop = createDesktopState(rootPane, desktopName, projectRoot);
  return {
    panes: { ...state.panes, [rootPane.id]: rootPane },
    desktops: [...state.desktops, desktop],
    activeDesktopId: desktop.id,
  };
}

export function setDesktopProjectRoot(
  state: WorkspaceState,
  desktopId: string,
  projectRoot: string,
): WorkspaceState {
  return updateDesktop(state, desktopId, (desktop) => ({ ...desktop, projectRoot }));
}

export function closeDesktop(
  state: WorkspaceState,
  desktopId: string,
): CloseDesktopResult {
  if (state.desktops.length <= 1) {
    return { workspace: state, removedSessionIds: [] };
  }
  const target = state.desktops.find((entry) => entry.id === desktopId);
  if (!target) {
    return { workspace: state, removedSessionIds: [] };
  }

  const removedPaneIds = target.layout ? orderedPaneIds(target.layout) : [];
  const removedSessionIds = removedPaneIds
    .map((paneId) => state.panes[paneId]?.sessionId)
    .filter((sessionId): sessionId is string => Boolean(sessionId));

  const panes = { ...state.panes };
  for (const paneId of removedPaneIds) delete panes[paneId];

  const desktops = state.desktops.filter((entry) => entry.id !== desktopId);
  const activeDesktopId =
    state.activeDesktopId === desktopId ? desktops[0]!.id : state.activeDesktopId;

  return {
    workspace: { panes, desktops, activeDesktopId },
    removedSessionIds,
  };
}

export function switchDesktop(
  state: WorkspaceState,
  desktopId: string,
): WorkspaceState {
  if (!state.desktops.some((entry) => entry.id === desktopId)) return state;
  if (state.activeDesktopId === desktopId) return state;
  return { ...state, activeDesktopId: desktopId };
}

export function renameDesktop(
  state: WorkspaceState,
  desktopId: string,
  name: string,
): WorkspaceState {
  const trimmed = name.trim();
  if (!trimmed) return state;
  return updateDesktop(state, desktopId, (desktop) => ({ ...desktop, name: trimmed }));
}

export function nextDesktopIdInDirection(
  state: WorkspaceState,
  direction: 1 | -1,
): string | null {
  const count = state.desktops.length;
  if (count <= 1) return null;
  const index = state.desktops.findIndex((entry) => entry.id === state.activeDesktopId);
  if (index < 0) return state.desktops[0]?.id ?? null;
  const nextIndex = (index + direction + count) % count;
  return state.desktops[nextIndex]!.id;
}

export function orderedPaneIds(node: LayoutNode): string[] {
  if (node.type === "leaf") {
    return [node.paneId];
  }
  return node.children.flatMap(orderedPaneIds);
}

export function findAdjacentPaneId(
  node: LayoutNode,
  paneId: string,
  direction: FocusDirection,
): string | null {
  const rects = collectPaneRects(node);
  const currentRect = rects[paneId];
  if (!currentRect) {
    return null;
  }

  let best: { paneId: string; score: [number, number, number, string] } | null = null;

  for (const [candidatePaneId, candidateRect] of Object.entries(rects)) {
    if (candidatePaneId === paneId) continue;
    const score = scoreAdjacentRect(currentRect, candidateRect, candidatePaneId, direction);
    if (!score) continue;

    if (!best || compareScore(score, best.score) < 0) {
      best = { paneId: candidatePaneId, score };
    }
  }

  return best?.paneId ?? null;
}

function replaceLeaf(node: LayoutNode, paneId: string, replacement: LayoutNode): LayoutNode {
  if (node.type === "leaf") {
    return node.paneId === paneId ? replacement : node;
  }

  return {
    ...node,
    children: node.children.map((child) => replaceLeaf(child, paneId, replacement)),
  };
}

function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "leaf") {
    return node.paneId === paneId ? null : node;
  }

  const children: LayoutNode[] = [];
  const weights: number[] = [];

  for (const [index, child] of node.children.entries()) {
    const nextChild = removeLeaf(child, paneId);
    if (!nextChild) continue;
    children.push(nextChild);
    weights.push(node.weights[index] ?? 1);
  }

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  return {
    ...node,
    children,
    weights,
  };
}

export function resizeSplitWeights(
  weights: number[],
  handleIndex: number,
  delta: number,
  minWeight = 0.2,
): number[] {
  const leftWeight = weights[handleIndex];
  const rightWeight = weights[handleIndex + 1];
  if (leftWeight === undefined || rightWeight === undefined) {
    return weights;
  }

  const combined = leftWeight + rightWeight;
  const nextLeft = clampWeight(leftWeight + delta, minWeight, combined - minWeight);
  const nextRight = combined - nextLeft;

  return weights.map((weight, index) => {
    if (index === handleIndex) return roundWeight(nextLeft);
    if (index === handleIndex + 1) return roundWeight(nextRight);
    return weight;
  });
}

function updateSplitAtPath(
  node: LayoutNode,
  path: LayoutPath,
  updater: (node: Extract<LayoutNode, { type: "split" }>) => LayoutNode,
): LayoutNode {
  if (path.length === 0) {
    return node.type === "split" ? updater(node) : node;
  }
  if (node.type === "leaf") {
    return node;
  }

  const [childIndex, ...rest] = path;
  const child = node.children[childIndex];
  if (!child) {
    return node;
  }

  const nextChild = updateSplitAtPath(child, rest, updater);
  if (nextChild === child) {
    return node;
  }

  return {
    ...node,
    children: node.children.map((entry, index) => (index === childIndex ? nextChild : entry)),
  };
}

function clampWeight(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundWeight(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

interface PaneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function collectPaneRects(
  node: LayoutNode,
  rect: PaneRect = { left: 0, top: 0, right: 1, bottom: 1 },
): Record<string, PaneRect> {
  if (node.type === "leaf") {
    return { [node.paneId]: rect };
  }

  const totalWeight = node.weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return {};
  }

  let cursor = node.direction === "horizontal" ? rect.left : rect.top;
  const entries: Record<string, PaneRect> = {};

  node.children.forEach((child, index) => {
    const weight = node.weights[index] ?? 0;
    const ratio = weight / totalWeight;
    const childRect =
      node.direction === "horizontal"
        ? {
            left: cursor,
            top: rect.top,
            right: cursor + (rect.right - rect.left) * ratio,
            bottom: rect.bottom,
          }
        : {
            left: rect.left,
            top: cursor,
            right: rect.right,
            bottom: cursor + (rect.bottom - rect.top) * ratio,
          };
    cursor = node.direction === "horizontal" ? childRect.right : childRect.bottom;
    Object.assign(entries, collectPaneRects(child, childRect));
  });

  return entries;
}

function scoreAdjacentRect(
  current: PaneRect,
  candidate: PaneRect,
  candidatePaneId: string,
  direction: FocusDirection,
): [number, number, number, string] | null {
  const epsilon = 1e-6;
  const currentCenterX = (current.left + current.right) / 2;
  const currentCenterY = (current.top + current.bottom) / 2;
  const candidateCenterX = (candidate.left + candidate.right) / 2;
  const candidateCenterY = (candidate.top + candidate.bottom) / 2;

  if (direction === "left") {
    if (candidate.right > current.left + epsilon) return null;
    const overlap = overlapLength(current.top, current.bottom, candidate.top, candidate.bottom);
    if (overlap <= epsilon) return null;
    return [
      roundMetric(current.left - candidate.right),
      roundMetric(Math.abs(candidateCenterY - currentCenterY)),
      roundMetric(-overlap),
      candidatePaneId,
    ];
  }

  if (direction === "right") {
    if (candidate.left < current.right - epsilon) return null;
    const overlap = overlapLength(current.top, current.bottom, candidate.top, candidate.bottom);
    if (overlap <= epsilon) return null;
    return [
      roundMetric(candidate.left - current.right),
      roundMetric(Math.abs(candidateCenterY - currentCenterY)),
      roundMetric(-overlap),
      candidatePaneId,
    ];
  }

  if (direction === "up") {
    if (candidate.bottom > current.top + epsilon) return null;
    const overlap = overlapLength(current.left, current.right, candidate.left, candidate.right);
    if (overlap <= epsilon) return null;
    return [
      roundMetric(current.top - candidate.bottom),
      roundMetric(Math.abs(candidateCenterX - currentCenterX)),
      roundMetric(-overlap),
      candidatePaneId,
    ];
  }

  if (candidate.top < current.bottom - epsilon) return null;
  const overlap = overlapLength(current.left, current.right, candidate.left, candidate.right);
  if (overlap <= epsilon) return null;
  return [
    roundMetric(candidate.top - current.bottom),
    roundMetric(Math.abs(candidateCenterX - currentCenterX)),
    roundMetric(-overlap),
    candidatePaneId,
  ];
}

function overlapLength(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function compareScore(
  left: [number, number, number, string],
  right: [number, number, number, string],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
