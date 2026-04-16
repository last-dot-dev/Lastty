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

export interface WorkspaceState {
  panes: Record<string, PaneRecord>;
  layout: LayoutNode;
  focusedPaneId: string | null;
}

export function createPaneRecord(sessionId: string, title = "shell"): PaneRecord {
  return {
    id: `pane-${sessionId}`,
    sessionId,
    title,
  };
}

export function createWorkspace(rootPane: PaneRecord): WorkspaceState {
  return {
    panes: { [rootPane.id]: rootPane },
    layout: { type: "leaf", paneId: rootPane.id },
    focusedPaneId: rootPane.id,
  };
}

export function focusPane(state: WorkspaceState, paneId: string): WorkspaceState {
  if (!(paneId in state.panes)) return state;
  return { ...state, focusedPaneId: paneId };
}

export function focusAdjacentPane(
  state: WorkspaceState,
  direction: FocusDirection,
): WorkspaceState {
  const paneId = state.focusedPaneId;
  if (!paneId) return state;
  const nextPaneId = findAdjacentPaneId(state.layout, paneId, direction);
  return nextPaneId ? focusPane(state, nextPaneId) : state;
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
      [pane.id]: {
        ...pane,
        title,
      },
    },
  };
}

export function splitPane(
  state: WorkspaceState,
  paneId: string,
  direction: SplitDirection,
  nextPane: PaneRecord,
): WorkspaceState {
  if (!(paneId in state.panes)) return state;
  const layout = replaceLeaf(state.layout, paneId, {
    type: "split",
    direction,
    children: [
      { type: "leaf", paneId },
      { type: "leaf", paneId: nextPane.id },
    ],
    weights: [1, 1],
  });
  return {
    panes: {
      ...state.panes,
      [nextPane.id]: nextPane,
    },
    layout,
    focusedPaneId: nextPane.id,
  };
}

export function resizeSplit(
  state: WorkspaceState,
  path: LayoutPath,
  handleIndex: number,
  delta: number,
  baseWeights?: number[],
): WorkspaceState {
  const layout = updateSplitAtPath(state.layout, path, (node) => {
    const sourceWeights =
      baseWeights && baseWeights.length === node.weights.length ? baseWeights : node.weights;
    const nextWeights = resizeSplitWeights(sourceWeights, handleIndex, delta);
    if (
      nextWeights.length === node.weights.length &&
      nextWeights.every((weight, index) => weight === node.weights[index])
    ) {
      return node;
    }
    return {
      ...node,
      weights: nextWeights,
    };
  });

  return layout === state.layout
    ? state
    : {
        ...state,
        layout,
      };
}

export function closePane(state: WorkspaceState, paneId: string): WorkspaceState {
  if (!(paneId in state.panes) || Object.keys(state.panes).length === 1) {
    return state;
  }

  const layout = removeLeaf(state.layout, paneId);
  if (!layout) return state;

  const panes = { ...state.panes };
  delete panes[paneId];
  const ordered = orderedPaneIds(layout);

  return {
    panes,
    layout,
    focusedPaneId: ordered.includes(state.focusedPaneId ?? "")
      ? state.focusedPaneId
      : ordered[0] ?? null,
  };
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
