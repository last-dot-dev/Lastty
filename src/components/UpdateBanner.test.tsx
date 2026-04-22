// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UpdateBanner, { shouldShowBanner } from "./UpdateBanner";
import {
  UpdaterStore,
  type UpdaterDeps,
  type UpdaterPhase,
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
    root.render(<UpdateBanner store={store} {...props} />);
  });
}

function banner(): HTMLElement | null {
  return container.querySelector(".agent-update-banner");
}

function message(): string {
  return container.querySelector(".agent-update-banner__message")?.textContent ?? "";
}

describe("shouldShowBanner", () => {
  const baseline: UpdaterState = {
    phase: "idle",
    version: null,
    currentVersion: null,
    progress: { downloadedBytes: 0, totalBytes: null },
    error: null,
    releaseNotesUrl: null,
    lastDismissedPhase: null,
  };

  const hidden: UpdaterPhase[] = ["idle", "downloading", "installing"];
  const visible: UpdaterPhase[] = ["downloaded", "ready-to-restart", "error"];

  it.each(hidden)("hides for phase %s", (phase) => {
    expect(shouldShowBanner({ ...baseline, phase })).toBe(false);
  });

  it.each(visible)("shows for phase %s", (phase) => {
    expect(shouldShowBanner({ ...baseline, phase })).toBe(true);
  });

  it.each(visible)("hides when user dismissed phase %s", (phase) => {
    expect(
      shouldShowBanner({ ...baseline, phase, lastDismissedPhase: phase }),
    ).toBe(false);
  });

  it("re-shows after dismiss once phase changes", () => {
    expect(
      shouldShowBanner({
        ...baseline,
        phase: "ready-to-restart",
        lastDismissedPhase: "downloaded",
      }),
    ).toBe(true);
  });
});

describe("UpdateBanner", () => {
  it("renders nothing while idle", () => {
    const store = new FakeStore();
    render(store);
    expect(banner()).toBeNull();
  });

  it("renders nothing while downloading", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "downloading", version: "1.0.0" });
    render(store);
    expect(banner()).toBeNull();
  });

  it("renders nothing while installing", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "installing", version: "1.0.0" });
    render(store);
    expect(banner()).toBeNull();
  });

  it("shows restart copy when ready-to-restart", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    render(store, { activeSessionCount: 0 });

    expect(banner()).not.toBeNull();
    expect(message()).toContain("A new version of Lastty (v2.0.0) is ready");
    expect(message()).toContain("Restart to update.");
    expect(message()).not.toContain("active session");
  });

  it("warns about active sessions in restart copy", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    render(store, { activeSessionCount: 3 });
    expect(message()).toContain("3 active sessions will end.");
  });

  it("uses singular 'session' for one active session", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    render(store, { activeSessionCount: 1 });
    expect(message()).toContain("1 active session will end.");
  });

  it("calls requestRestart when primary button clicked", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    const restart = vi.spyOn(store, "requestRestart").mockResolvedValue();
    render(store);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(".agent-update-banner__action")
        ?.click();
    });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("calls beginInstall from downloaded phase", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "downloaded", version: "1.0.1" });
    const install = vi.spyOn(store, "beginInstall").mockResolvedValue();
    render(store);

    expect(message()).toContain("Install to continue.");
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".agent-update-banner__action")
        ?.click();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("shows error message and calls retry", () => {
    const store = new FakeStore();
    store.setPhase({
      phase: "error",
      error: { phase: "download", message: "boom" },
    });
    const retry = vi.spyOn(store, "retry").mockResolvedValue();
    render(store);

    expect(banner()?.getAttribute("data-phase")).toBe("error");
    expect(message()).toContain("Update failed: boom");

    act(() => {
      container
        .querySelector<HTMLButtonElement>(".agent-update-banner__action")
        ?.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("dismiss hides the banner for the current phase", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });
    render(store);

    expect(banner()).not.toBeNull();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".agent-update-banner__dismiss")
        ?.click();
    });
    expect(banner()).toBeNull();
  });

  it("dismiss does not carry across phase transitions", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "downloaded", version: "2.0.0" });
    render(store);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(".agent-update-banner__dismiss")
        ?.click();
    });
    expect(banner()).toBeNull();

    act(() => {
      store.setPhase({ phase: "ready-to-restart" });
    });
    expect(banner()).not.toBeNull();
  });
});

describe("UpdaterStore.dismissBanner", () => {
  it("records the current phase and notifies listeners", () => {
    const store = new FakeStore();
    store.setPhase({ phase: "ready-to-restart", version: "2.0.0" });

    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dismissBanner();
    unsubscribe();

    expect(store.getState().lastDismissedPhase).toBe("ready-to-restart");
    expect(listener).toHaveBeenCalled();
  });
});
