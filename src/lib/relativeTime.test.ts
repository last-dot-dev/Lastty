import { describe, expect, it } from "vitest";

import { formatRelative } from "./relativeTime";

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
