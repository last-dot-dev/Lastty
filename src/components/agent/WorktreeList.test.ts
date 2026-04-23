import { describe, expect, it } from "vitest";

import { buildWorktreeOptions, type WorktreeRow } from "./WorktreeList";

const basename = (path: string) => path.split("/").pop() ?? "";

function row(overrides: Partial<WorktreeRow> & Pick<WorktreeRow, "path">): WorktreeRow {
  return {
    branchName: "",
    isLastty: false,
    isMain: false,
    uncommittedFiles: 0,
    unmergedCommits: 0,
    changedFiles: [],
    liveSessions: 0,
    firstLivePaneId: null,
    merged: false,
    ...overrides,
  };
}

describe("buildWorktreeOptions", () => {
  it("always includes in_place as first option for agents", () => {
    const options = buildWorktreeOptions(false, [], basename);
    expect(options[0]!.value).toBe("in_place");
  });

  it("always includes in_place as first option for shells", () => {
    const options = buildWorktreeOptions(true, [], basename);
    expect(options[0]!.value).toBe("in_place");
  });

  it("includes new worktree option for agents but not shells", () => {
    const agentOptions = buildWorktreeOptions(false, [], basename);
    const shellOptions = buildWorktreeOptions(true, [], basename);
    expect(agentOptions.some((o) => o.value === "new")).toBe(true);
    expect(shellOptions.some((o) => o.value === "new")).toBe(false);
  });

  it("excludes the main worktree from listed options", () => {
    const worktrees = [
      row({ path: "/repo", isMain: true, branchName: "main" }),
      row({ path: "/repo/.lastty-worktrees/feat", branchName: "feat", isLastty: true }),
    ];
    const options = buildWorktreeOptions(false, worktrees, basename);
    expect(options.some((o) => o.value === "/repo")).toBe(false);
    expect(options.some((o) => o.value === "/repo/.lastty-worktrees/feat")).toBe(true);
  });

  it("labels worktree by branchName when present, falling back to basename", () => {
    const withBranch = row({ path: "/repo/.lastty-worktrees/feat", branchName: "feat-auth" });
    const withoutBranch = row({ path: "/repo/.lastty-worktrees/detached", branchName: "" });
    const options = buildWorktreeOptions(false, [withBranch, withoutBranch], basename);
    const feat = options.find((o) => o.value === withBranch.path);
    const detached = options.find((o) => o.value === withoutBranch.path);
    expect(feat!.label).toBe("feat-auth");
    expect(detached!.label).toBe("detached");
  });

  it("shell default falls to in_place when worktrees exist", () => {
    const worktrees = [
      row({ path: "/repo/.lastty-worktrees/feat", branchName: "feat", isLastty: true }),
    ];
    const options = buildWorktreeOptions(true, worktrees, basename);
    expect(options[0]!.value).toBe("in_place");
  });
});
