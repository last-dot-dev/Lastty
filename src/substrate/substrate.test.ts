import { describe, expect, it } from "vitest";

import { applyPatch } from "./useAppDoc";

describe("applyPatch", () => {
  it("puts at root", () => {
    const out = applyPatch({ a: 1 }, { op: "put", path: ["b"], value: 2 });
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it("puts at nested path", () => {
    const out = applyPatch(
      { t: { d: "x" } },
      { op: "put", path: ["t", "d"], value: "y" },
    );
    expect(out).toEqual({ t: { d: "y" } });
  });

  it("inserts into list", () => {
    const out = applyPatch(
      { xs: [1, 3] },
      { op: "insert", path: ["xs"], index: 1, value: 2 },
    );
    expect(out).toEqual({ xs: [1, 2, 3] });
  });

  it("deletes key", () => {
    const out = applyPatch(
      { a: 1, b: 2 },
      { op: "delete", path: ["a"] },
    );
    expect(out).toEqual({ b: 2 });
  });

  it("inserts nested list item", () => {
    const out = applyPatch(
      { activities: [{ t: "a" }] },
      { op: "insert", path: ["activities"], index: 1, value: { t: "b" } },
    );
    expect(out).toEqual({ activities: [{ t: "a" }, { t: "b" }] });
  });
});
