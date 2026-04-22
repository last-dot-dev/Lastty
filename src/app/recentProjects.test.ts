import { beforeEach, describe, expect, it } from "vitest";

import {
  getRecentProjects,
  pushRecentProject,
  removeRecentProject,
} from "./recentProjects";

function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
  };
}

let storage: Storage;

beforeEach(() => {
  storage = makeStorage();
});

describe("recentProjects", () => {
  it("stores pushed entries newest-first", () => {
    pushRecentProject("/a", 100, storage);
    pushRecentProject("/b", 200, storage);
    pushRecentProject("/c", 300, storage);

    expect(getRecentProjects(storage).map((entry) => entry.path)).toEqual([
      "/c",
      "/b",
      "/a",
    ]);
  });

  it("dedupes by canonicalized path and refreshes lastUsedMs", () => {
    pushRecentProject("/projects/foo", 100, storage);
    pushRecentProject("/projects/bar", 200, storage);
    pushRecentProject("/projects/foo/", 300, storage);

    const entries = getRecentProjects(storage);
    expect(entries.map((entry) => entry.path)).toEqual([
      "/projects/foo",
      "/projects/bar",
    ]);
    expect(entries[0]!.lastUsedMs).toBe(300);
  });

  it("caps the list at 20 entries", () => {
    for (let i = 0; i < 25; i += 1) {
      pushRecentProject(`/p${i}`, i, storage);
    }
    const entries = getRecentProjects(storage);
    expect(entries).toHaveLength(20);
    expect(entries[0]!.path).toBe("/p24");
    expect(entries[19]!.path).toBe("/p5");
  });

  it("ignores empty paths", () => {
    pushRecentProject("", 100, storage);
    expect(getRecentProjects(storage)).toEqual([]);
  });

  it("removes entries and tolerates missing ones", () => {
    pushRecentProject("/a", 100, storage);
    pushRecentProject("/b", 200, storage);

    removeRecentProject("/a", storage);
    expect(getRecentProjects(storage).map((entry) => entry.path)).toEqual([
      "/b",
    ]);

    removeRecentProject("/missing", storage);
    expect(getRecentProjects(storage).map((entry) => entry.path)).toEqual([
      "/b",
    ]);
  });

  it("returns an empty list when storage is corrupted", () => {
    storage.setItem("lastty.recentProjects.v1", "{not-json");
    expect(getRecentProjects(storage)).toEqual([]);
  });
});
