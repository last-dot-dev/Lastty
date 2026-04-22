import { describe, expect, it } from "vitest";

import {
  basename,
  isValidCloneUrl,
  parentPath,
  previewRepoName,
} from "./NewViewWelcome.logic";

describe("NewViewWelcome.logic", () => {
  describe("basename", () => {
    it("returns the final path segment, stripping trailing slashes", () => {
      expect(basename("/foo/bar")).toBe("bar");
      expect(basename("/foo/bar/")).toBe("bar");
      expect(basename("bar")).toBe("bar");
      expect(basename("")).toBe("");
      expect(basename("/")).toBe("");
    });
  });

  describe("parentPath", () => {
    it("returns the parent directory", () => {
      expect(parentPath("/foo/bar")).toBe("/foo");
      expect(parentPath("/foo/bar/")).toBe("/foo");
      expect(parentPath("/bar")).toBe("/");
      expect(parentPath("bar")).toBe("");
    });
  });

  describe("isValidCloneUrl", () => {
    it.each([
      "https://github.com/cli/cli",
      "https://github.com/cli/cli.git",
      "http://example.com/repo.git",
      "ssh://git@github.com/cli/cli.git",
      "git://example.com/repo.git",
      "git@github.com:cli/cli.git",
    ])("accepts %s", (url) => {
      expect(isValidCloneUrl(url)).toBe(true);
    });

    it.each([
      "",
      "  ",
      "https://",
      "ssh://",
      "/tmp/local-path",
      "--upload-pack=/bin/sh",
      "; rm -rf /",
      "git@",
      "git@github.com",
      "git@:path",
      "git@host:",
    ])("rejects %s", (url) => {
      expect(isValidCloneUrl(url)).toBe(false);
    });
  });

  describe("previewRepoName", () => {
    it("derives a repo name from common URL shapes", () => {
      expect(previewRepoName("https://github.com/cli/cli")).toBe("cli");
      expect(previewRepoName("https://github.com/cli/cli.git")).toBe("cli");
      expect(previewRepoName("https://github.com/cli/cli/")).toBe("cli");
      expect(previewRepoName("git@github.com:cli/cli.git")).toBe("cli");
      expect(previewRepoName("ssh://git@host/group/sub/proj.git")).toBe("proj");
    });

    it("returns empty string when nothing sensible can be derived", () => {
      expect(previewRepoName("")).toBe("");
      expect(previewRepoName(".git")).toBe("");
    });
  });
});
