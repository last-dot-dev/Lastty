import { useMemo } from "react";

import {
  laneColor,
  type GraphLayout,
  type LaidOutCommit,
} from "../../lib/graphLayout";
import { formatRelative } from "../../lib/relativeTime";

const LANE_W = 12;
const ROW_H = 22;
const DOT_R = 3.5;
const GUTTER = 6;

export default function CommitGraph({
  layout,
  headSha,
  headRef,
  nowMs,
}: {
  layout: GraphLayout;
  headSha: string | null;
  headRef: string | null;
  nowMs: number;
}) {
  const gutter = useMemo(
    () => layout.laneCount * LANE_W + GUTTER,
    [layout.laneCount],
  );

  return (
    <div className="agent-graph-rows">
      {layout.rows.map((row) => (
        <CommitRow
          key={row.sha}
          row={row}
          gutter={gutter}
          laneCount={layout.laneCount}
          isHead={row.sha === headSha}
          headRef={headRef}
          nowMs={nowMs}
        />
      ))}
    </div>
  );
}

function CommitRow({
  row,
  gutter,
  laneCount,
  isHead,
  headRef,
  nowMs,
}: {
  row: LaidOutCommit;
  gutter: number;
  laneCount: number;
  isHead: boolean;
  headRef: string | null;
  nowMs: number;
}) {
  return (
    <div className="agent-graph-row" title={`${row.sha.slice(0, 7)} · ${row.author}`}>
      <svg
        className="agent-graph-row__svg"
        width={gutter}
        height={ROW_H}
        viewBox={`0 0 ${gutter} ${ROW_H}`}
        aria-hidden
      >
        {renderEdges(row, laneCount)}
        <circle
          cx={laneX(row.lane)}
          cy={ROW_H / 2}
          r={DOT_R}
          fill={row.color}
          stroke="var(--color-background-primary)"
          strokeWidth={1}
        />
      </svg>
      <span className="agent-graph-row__subject">{row.subject}</span>
      {isHead && headRef && (
        <span className="agent-graph-row__badge">{headRef}</span>
      )}
      <span className="agent-graph-row__time">
        {formatRelative(row.committed_at, nowMs)}
      </span>
    </div>
  );
}

function renderEdges(row: LaidOutCommit, laneCount: number) {
  const paths: React.ReactNode[] = [];
  const ownLaneHadSha = row.lanesBefore[row.lane] === row.sha;

  for (let L = 0; L < laneCount; L++) {
    const before = row.lanesBefore[L] ?? null;
    const isMergeIn = before === row.sha && L !== row.lane;
    const isOwnLaneTop = L === row.lane && ownLaneHadSha;
    const isPassThroughTop = before !== null && !isMergeIn && !isOwnLaneTop && L !== row.lane;

    if (isMergeIn) {
      paths.push(
        <path
          key={`merge-${L}`}
          d={curve(laneX(L), 0, laneX(row.lane), ROW_H / 2)}
          stroke={laneColor(L)}
          strokeWidth={1.5}
          fill="none"
        />,
      );
    } else if (isOwnLaneTop) {
      paths.push(
        <line
          key={`own-top-${L}`}
          x1={laneX(L)}
          y1={0}
          x2={laneX(L)}
          y2={ROW_H / 2}
          stroke={row.color}
          strokeWidth={1.5}
        />,
      );
    } else if (isPassThroughTop) {
      paths.push(
        <line
          key={`through-top-${L}`}
          x1={laneX(L)}
          y1={0}
          x2={laneX(L)}
          y2={ROW_H / 2}
          stroke={laneColor(L)}
          strokeWidth={1.5}
        />,
      );
    }
  }

  for (let L = 0; L < laneCount; L++) {
    const after = row.lanesAfter[L] ?? null;
    const isFork = row.parentLanes.includes(L) && L !== row.lane;
    const isOwnLaneBottom = L === row.lane && after !== null;
    const isPassThroughBottom =
      after !== null && !isFork && !isOwnLaneBottom && L !== row.lane;

    if (isFork) {
      paths.push(
        <path
          key={`fork-${L}`}
          d={curve(laneX(row.lane), ROW_H / 2, laneX(L), ROW_H)}
          stroke={laneColor(L)}
          strokeWidth={1.5}
          fill="none"
        />,
      );
    } else if (isOwnLaneBottom) {
      paths.push(
        <line
          key={`own-bottom-${L}`}
          x1={laneX(L)}
          y1={ROW_H / 2}
          x2={laneX(L)}
          y2={ROW_H}
          stroke={row.color}
          strokeWidth={1.5}
        />,
      );
    } else if (isPassThroughBottom) {
      paths.push(
        <line
          key={`through-bottom-${L}`}
          x1={laneX(L)}
          y1={ROW_H / 2}
          x2={laneX(L)}
          y2={ROW_H}
          stroke={laneColor(L)}
          strokeWidth={1.5}
        />,
      );
    }
  }

  return paths;
}

function laneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}
