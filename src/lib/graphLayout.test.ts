import { describe, expect, it } from "vitest";

import type { GitCommit } from "./ipc";
import { headRefFromCommitRefs, layoutGraph } from "./graphLayout";

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

describe("headRefFromCommitRefs", () => {
  it("extracts branch after HEAD ->", () => {
    expect(headRefFromCommitRefs(["HEAD -> main", "origin/main"])).toBe("main");
  });

  it("returns null when no HEAD ref is present", () => {
    expect(headRefFromCommitRefs(["origin/main", "tag: v1"])).toBeNull();
  });
});
