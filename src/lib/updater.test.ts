import { describe, expect, it, vi } from "vitest";

import { UpdaterStore, type UpdaterDeps } from "./updater";

type CheckFn = UpdaterDeps["check"];
type RelaunchFn = UpdaterDeps["relaunch"];

interface FakeUpdateOptions {
  version?: string;
  currentVersion?: string;
  onDownload?: (emit: (event: unknown) => void) => Promise<void>;
  install?: () => Promise<void>;
}

function makeFakeUpdate(options: FakeUpdateOptions = {}) {
  const download = vi.fn(async (cb: (event: unknown) => void) => {
    if (options.onDownload) {
      await options.onDownload(cb);
      return;
    }
    cb({ event: "Started", data: { contentLength: 100 } });
    cb({ event: "Progress", data: { chunkLength: 50 } });
    cb({ event: "Progress", data: { chunkLength: 50 } });
    cb({ event: "Finished" });
  });
  const install = vi.fn(options.install ?? (async () => {}));
  return {
    version: options.version ?? "1.2.3",
    currentVersion: options.currentVersion ?? "1.2.2",
    download,
    install,
  } as unknown as Awaited<ReturnType<CheckFn>>;
}

function captureStates(store: UpdaterStore) {
  const phases: string[] = [];
  store.subscribe(() => {
    phases.push(store.getState().phase);
  });
  return phases;
}

describe("UpdaterStore", () => {
  it("stays idle when check returns null", async () => {
    const check = vi.fn(async () => null) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.checkAndDownload();

    expect(store.getState().phase).toBe("idle");
    expect(store.getState().version).toBeNull();
  });

  it("transitions idle → downloading → downloaded", async () => {
    const update = makeFakeUpdate();
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });
    const phases = captureStates(store);

    await store.checkAndDownload();

    expect(phases).toEqual([
      "downloading",
      "downloading",
      "downloading",
      "downloading",
      "downloaded",
    ]);
    const state = store.getState();
    expect(state.version).toBe("1.2.3");
    expect(state.currentVersion).toBe("1.2.2");
    expect(state.progress.downloadedBytes).toBe(100);
    expect(state.progress.totalBytes).toBe(100);
    expect(state.releaseNotesUrl).toContain("v1.2.3");
  });

  it("transitions downloaded → installing → ready-to-restart", async () => {
    const update = makeFakeUpdate();
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.checkAndDownload();
    await store.beginInstall();

    expect(store.getState().phase).toBe("ready-to-restart");
    // @ts-expect-error fake update
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it("calls relaunch only from ready-to-restart", async () => {
    const update = makeFakeUpdate();
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn(async () => {}) as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.requestRestart();
    expect(relaunch).not.toHaveBeenCalled();

    await store.checkAndDownload();
    await store.beginInstall();
    await store.requestRestart();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("reports download errors via error state", async () => {
    const update = makeFakeUpdate({
      onDownload: async () => {
        throw new Error("network down");
      },
    });
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.checkAndDownload();

    const state = store.getState();
    expect(state.phase).toBe("error");
    expect(state.error?.phase).toBe("download");
    expect(state.error?.message).toBe("network down");
  });

  it("reports check errors via error state", async () => {
    const check = vi.fn(async () => {
      throw new Error("no network");
    }) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.checkAndDownload();

    const state = store.getState();
    expect(state.phase).toBe("error");
    expect(state.error?.phase).toBe("check");
  });

  it("retries the failed phase", async () => {
    let fail = true;
    const update = makeFakeUpdate({
      onDownload: async (emit) => {
        if (fail) {
          fail = false;
          throw new Error("flaky");
        }
        emit({ event: "Started", data: { contentLength: 10 } });
        emit({ event: "Progress", data: { chunkLength: 10 } });
      },
    });
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.checkAndDownload();
    expect(store.getState().phase).toBe("error");

    await store.retry();
    expect(store.getState().phase).toBe("downloaded");
  });

  it("userCheckForUpdates clears dismiss flag and triggers a check", async () => {
    const update = makeFakeUpdate();
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.checkAndDownload();
    await store.beginInstall();
    store.dismissBanner();
    expect(store.getState().lastDismissedPhase).toBe("ready-to-restart");

    await store.userCheckForUpdates();

    expect(store.getState().lastDismissedPhase).toBeNull();
  });

  it("userCheckForUpdates from idle kicks off a check", async () => {
    const update = makeFakeUpdate();
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    await store.userCheckForUpdates();

    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getState().phase).toBe("downloaded");
  });

  it("guards against concurrent downloads", async () => {
    const startedRef: { fn: (() => void) | null } = { fn: null };
    const downloadRef: { fn: (() => void) | null } = { fn: null };
    const started = new Promise<void>((resolve) => {
      startedRef.fn = resolve;
    });
    const update = makeFakeUpdate({
      onDownload: (emit) =>
        new Promise((resolve) => {
          emit({ event: "Started", data: { contentLength: 1 } });
          downloadRef.fn = () => {
            emit({ event: "Progress", data: { chunkLength: 1 } });
            resolve();
          };
          startedRef.fn?.();
        }),
    });
    const check = vi.fn(async () => update) as unknown as CheckFn;
    const relaunch = vi.fn() as unknown as RelaunchFn;
    const store = new UpdaterStore({ check, relaunch });

    const first = store.checkAndDownload();
    await started;
    const second = store.checkAndDownload();
    expect(first).toBe(second);

    downloadRef.fn?.();
    await first;

    expect(check).toHaveBeenCalledTimes(1);
  });
});
