import { describe, expect, it } from "vitest";

import type { GitCommit } from "./ipc";
import { formatRelative, headRefFromCommitRefs, layoutGraph } from "./graphLayout";

function commit(overrides: Partial<GitCommit> & Pick<GitCommit, "sha" | "parents">): GitCommit {
  return {
    subject: `subject-${overrides.sha}`,
    author: "Alice",
    committed_at: 0,
    refs: [],
    ...overrides,
  };
}

describe("layoutGraph", () => {
  it("lays out a linear history in a single lane", () => {
    const result = layoutGraph([
      commit({ sha: "c", parents: ["b"] }),
      commit({ sha: "b", parents: ["a"] }),
      commit({ sha: "a", parents: [] }),
    ]);
    expect(result.laneCount).toBe(1);
    expect(result.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(result.rows[2]!.lanesAfter).toEqual([null]);
  });

  it("places two concurrent tips into separate lanes", () => {
    const result = layoutGraph([
      commit({ sha: "x", parents: ["root"] }),
      commit({ sha: "y", parents: ["root"] }),
      commit({ sha: "root", parents: [] }),
    ]);
    expect(result.rows[0]!.lane).toBe(0);
    expect(result.rows[1]!.lane).toBe(1);
    expect(result.rows[2]!.lane).toBe(0);
    expect(result.rows[2]!.lanesAfter).toEqual([null, null]);
    expect(result.laneCount).toBe(2);
  });

  it("merges a fork+merge topology back into one lane", () => {
    const result = layoutGraph([
      commit({ sha: "m", parents: ["a", "b"] }),
      commit({ sha: "a", parents: ["r"] }),
      commit({ sha: "b", parents: ["r"] }),
      commit({ sha: "r", parents: [] }),
    ]);
    expect(result.rows[0]!.lane).toBe(0);
    expect(result.rows[0]!.parentLanes).toEqual([0, 1]);
    expect(result.rows[1]!.lane).toBe(0);
    expect(result.rows[2]!.lane).toBe(1);
    expect(result.rows[3]!.lane).toBe(0);
    expect(result.rows[3]!.lanesAfter).toEqual([null, null]);
  });

  it("reuses a freed lane slot for a new tip", () => {
    const result = layoutGraph([
      commit({ sha: "x", parents: [] }),
      commit({ sha: "y", parents: [] }),
    ]);
    expect(result.rows[0]!.lane).toBe(0);
    expect(result.rows[1]!.lane).toBe(0);
    expect(result.rows[1]!.lanesBefore).toEqual([null]);
  });

  it("stamps stable colors per lane", () => {
    const result = layoutGraph([
      commit({ sha: "x", parents: ["root"] }),
      commit({ sha: "y", parents: ["root"] }),
      commit({ sha: "root", parents: [] }),
    ]);
    expect(result.rows[0]!.color).toBe(result.rows[2]!.color);
    expect(result.rows[0]!.color).not.toBe(result.rows[1]!.color);
  });
});

describe("formatRelative", () => {
  const now = 1_700_000_000_000;

  it("labels under one minute as <1m", () => {
    expect(formatRelative(now / 1000 - 30, now)).toBe("<1m");
  });

  it("rounds down to whole minutes", () => {
    expect(formatRelative(now / 1000 - 60, now)).toBe("1m");
    expect(formatRelative(now / 1000 - 119, now)).toBe("1m");
  });

  it("switches to hours at 60m", () => {
    expect(formatRelative(now / 1000 - 3600, now)).toBe("1h");
    expect(formatRelative(now / 1000 - 3599, now)).toBe("59m");
  });

  it("switches to days, months, years", () => {
    expect(formatRelative(now / 1000 - 86_400, now)).toBe("1d");
    expect(formatRelative(now / 1000 - 86_400 * 31, now)).toBe("1mo");
    expect(formatRelative(now / 1000 - 86_400 * 400, now)).toBe("1y");
  });

  it("clamps future timestamps to <1m", () => {
    expect(formatRelative(now / 1000 + 60, now)).toBe("<1m");
  });
});

describe("headRefFromCommitRefs", () => {
  it("extracts branch after HEAD ->", () => {
    expect(headRefFromCommitRefs(["HEAD -> main", "origin/main"])).toBe("main");
  });

  it("returns null when no HEAD ref is present", () => {
    expect(headRefFromCommitRefs(["origin/main", "tag: v1"])).toBeNull();
  });
});
