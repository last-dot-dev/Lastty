// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UpdateBadge from "./UpdateBadge";
import {
  UpdaterStore,
  type UpdaterDeps,
  type UpdaterState,
} from "../lib/updater";

const noopDeps: UpdaterDeps = {
  check: (async () => null) as UpdaterDeps["check"],
  relaunch: (async () => {}) as UpdaterDeps["relaunch"],
};

class FakeStore extends UpdaterStore {
  constructor() {
    super(noopDeps);
  }
  setPhase(patch: Partial<UpdaterState>): void {
    (this as unknown as {
      state: UpdaterState;
      listeners: Set<() => void>;
    }).state = {
      ...this.getState(),
      ...patch,
    };
    const listeners = (this as unknown as { listeners: Set<() => void> })
      .listeners;
    listeners.forEach((l) => l());
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(store: FakeStore, props: { activeSessionCount?: number } = {}) {
  act(() => {
    root.render(<UpdateBadge store={store} {...props} />);
  });
}

describe("UpdateBadge", () => {
  it("renders nothing while idle", () => {
    const store = new FakeStore();
    render(store);
    expect(container.querySelector(".update-badge")).toBeNull();
  });

  it("renders a spinner and progress while downloading", () => {
    const store = new FakeStore();
    store.setPhase({
      phase: "downloading",
      version: "9.9.9",
      progress: { downloadedBytes: 25, totalBytes: 100 },
      releaseNotesUrl: "https://example.test/v9.9.9",
    });
    render(store);

    const button = container.querySelector<HTMLButtonElement>(
      ".update-badge__button--downloading",
    );
    expect(button).not.toBeNull();
    expect(
      container.querySelector(".update-badge__indicator--spinner"),
    ).not.toBeNull();
    act(() => {
      button?.click();
    });
    expect(container.querySelector(".update-badge__popover")?.textContent).toContain(
      "Downloading v9.9.9",
    );
    expect(container.querySelector(".update-badge__progress-label")?.textContent).toBe(
      "25%",
    );
  });

  it("shows Install action when downloaded", () => {
    const store = new FakeStore();
    store.setPhase({
      phase: "downloaded",
      version: "1.0.1",
    });
    const beginInstall = vi.spyOn(store, "beginInstall").mockResolvedValue();
    render(store);

    act(() => {
      container.querySelector<HTMLButtonElement>(".update-badge__button")?.click();
    });
    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".update-badge__action"),
    );
    const install = actions.find((b) => b.textContent === "Install");
    act(() => {
      install?.click();
    });
    expect(beginInstall).toHaveBeenCalledTimes(1);
  });

  it("shows non-interactive spinner while installing", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "installing", version: "1.0.1" });
    render(store);

    const button = container.querySelector<HTMLButtonElement>(
      ".update-badge__button--installing",
    );
    expect(button?.disabled).toBe(true);
  });

  it("warns about active sessions in the restart confirm", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    render(store, { activeSessionCount: 3 });

    act(() => {
      container.querySelector<HTMLButtonElement>(".update-badge__button")?.click();
    });
    const body = container.querySelector(".update-badge__body")?.textContent ?? "";
    expect(body).toContain("3 terminal sessions are active");
  });

  it("omits warning when no active sessions", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    render(store, { activeSessionCount: 0 });

    act(() => {
      container.querySelector<HTMLButtonElement>(".update-badge__button")?.click();
    });
    const body = container.querySelector(".update-badge__body")?.textContent ?? "";
    expect(body).not.toContain("active");
    expect(body).toContain("Restart now or on next launch.");
  });

  it("calls requestRestart when Restart clicked", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    const restart = vi.spyOn(store, "requestRestart").mockResolvedValue();
    render(store, { activeSessionCount: 0 });

    act(() => {
      container.querySelector<HTMLButtonElement>(".update-badge__button")?.click();
    });
    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".update-badge__action"),
    );
    const restartButton = actions.find((b) => b.textContent === "Restart");
    act(() => {
      restartButton?.click();
    });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("exposes retry in error state", () => {
    const store = new FakeStore();
    store.setPhase({
      phase: "error",
      error: { phase: "download", message: "boom" },
    });
    const retry = vi.spyOn(store, "retry").mockResolvedValue();
    render(store);

    expect(
      container.querySelector(".update-badge__button--error"),
    ).not.toBeNull();
    act(() => {
      container.querySelector<HTMLButtonElement>(".update-badge__button")?.click();
    });
    expect(container.querySelector(".update-badge__body")?.textContent).toBe("boom");
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".update-badge__action--primary")
        ?.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
