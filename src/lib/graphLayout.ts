import type { GitCommit } from "./ipc";

export const LANE_PALETTE = [
  "#4fc3f7",
  "#ba68c8",
  "#ff8a65",
  "#81c784",
  "#f06292",
  "#ffd54f",
];

export function laneColor(lane: number): string {
  return LANE_PALETTE[lane % LANE_PALETTE.length]!;
}

export interface LaidOutCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  committed_at: number;
  refs: string[];
  row: number;
  lane: number;
  parentLanes: number[];
  lanesBefore: (string | null)[];
  lanesAfter: (string | null)[];
  color: string;
}

export interface GraphLayout {
  rows: LaidOutCommit[];
  laneCount: number;
}

export function layoutGraph(commits: GitCommit[]): GraphLayout {
  const active: (string | null)[] = [];
  const rows: LaidOutCommit[] = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]!;
    const lanesBefore = active.slice();

    const matching: number[] = [];
    for (let lane = 0; lane < active.length; lane++) {
      if (active[lane] === c.sha) matching.push(lane);
    }

    let lane: number;
    if (matching.length > 0) {
      lane = matching[0]!;
      for (let k = 1; k < matching.length; k++) {
        active[matching[k]!] = null;
      }
    } else {
      lane = assignLane(active, null);
    }

    const parentLanes: number[] = [];
    if (c.parents.length === 0) {
      active[lane] = null;
    } else {
      active[lane] = c.parents[0]!;
      parentLanes.push(lane);
      for (let p = 1; p < c.parents.length; p++) {
        const parent = c.parents[p]!;
        const existing = active.indexOf(parent);
        if (existing !== -1) {
          parentLanes.push(existing);
        } else {
          parentLanes.push(assignLane(active, parent));
        }
      }
    }

    const lanesAfter = active.slice();
    rows.push({
      sha: c.sha,
      parents: c.parents,
      subject: c.subject,
      author: c.author,
      committed_at: c.committed_at,
      refs: c.refs,
      row: i,
      lane,
      parentLanes,
      lanesBefore,
      lanesAfter,
      color: laneColor(lane),
    });
  }

  let laneCount = 0;
  for (const r of rows) {
    laneCount = Math.max(
      laneCount,
      r.lanesBefore.length,
      r.lanesAfter.length,
      r.lane + 1,
    );
  }
  return { rows, laneCount };
}

function assignLane(active: (string | null)[], value: string | null): number {
  const firstNull = active.indexOf(null);
  if (firstNull === -1) {
    active.push(value);
    return active.length - 1;
  }
  active[firstNull] = value;
  return firstNull;
}

export function formatRelative(unixSec: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (diffSec < 60) return "<1m";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

const HEAD_REF_PREFIX = "HEAD -> ";

export function headRefFromCommitRefs(refs: string[]): string | null {
  for (const ref of refs) {
    if (ref.startsWith(HEAD_REF_PREFIX)) {
      return ref.slice(HEAD_REF_PREFIX.length);
    }
  }
  return null;
}
