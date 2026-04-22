import {
  check as tauriCheck,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const RELEASE_NOTES_BASE =
  "https://github.com/last-dot-dev/Lastty/releases/tag/";

export type UpdaterPhase =
  | "idle"
  | "downloading"
  | "downloaded"
  | "installing"
  | "ready-to-restart"
  | "error";

export type UpdaterErrorPhase =
  | "check"
  | "download"
  | "install"
  | "relaunch";

export interface UpdaterError {
  phase: UpdaterErrorPhase;
  message: string;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface UpdaterState {
  phase: UpdaterPhase;
  version: string | null;
  currentVersion: string | null;
  progress: DownloadProgress;
  error: UpdaterError | null;
  releaseNotesUrl: string | null;
  lastDismissedPhase: UpdaterPhase | null;
}

export interface UpdaterDeps {
  check: typeof tauriCheck;
  relaunch: typeof tauriRelaunch;
}

const defaultDeps: UpdaterDeps = {
  check: tauriCheck,
  relaunch: tauriRelaunch,
};

type Listener = () => void;

const INITIAL_STATE: UpdaterState = {
  phase: "idle",
  version: null,
  currentVersion: null,
  progress: { downloadedBytes: 0, totalBytes: null },
  error: null,
  releaseNotesUrl: null,
  lastDismissedPhase: null,
};

export class UpdaterStore {
  private state: UpdaterState = INITIAL_STATE;
  private listeners = new Set<Listener>();
  private update: Update | null = null;
  private inflightCheck: Promise<void> | null = null;
  private deps: UpdaterDeps;

  constructor(deps: UpdaterDeps = defaultDeps) {
    this.deps = deps;
  }

  getState = (): UpdaterState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<UpdaterState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  checkAndDownload = (): Promise<void> => {
    if (this.inflightCheck) return this.inflightCheck;
    if (
      this.state.phase !== "idle" &&
      this.state.phase !== "error"
    ) {
      return Promise.resolve();
    }
    const run = this.runCheckAndDownload();
    this.inflightCheck = run.finally(() => {
      this.inflightCheck = null;
    });
    return this.inflightCheck;
  };

  private async runCheckAndDownload(): Promise<void> {
    let update: Update | null;
    try {
      update = await this.deps.check();
    } catch (error) {
      this.setState({
        phase: "error",
        error: { phase: "check", message: errorMessage(error) },
      });
      return;
    }
    if (!update) {
      this.setState({ ...INITIAL_STATE });
      return;
    }
    this.update = update;
    this.setState({
      phase: "downloading",
      version: update.version,
      currentVersion: update.currentVersion,
      progress: { downloadedBytes: 0, totalBytes: null },
      error: null,
      releaseNotesUrl: `${RELEASE_NOTES_BASE}v${update.version}`,
    });
    try {
      await update.download((event) => this.handleDownloadEvent(event));
    } catch (error) {
      this.setState({
        phase: "error",
        error: { phase: "download", message: errorMessage(error) },
      });
      return;
    }
    this.setState({ phase: "downloaded" });
  }

  private handleDownloadEvent(event: DownloadEvent): void {
    if (event.event === "Started") {
      this.setState({
        progress: {
          downloadedBytes: 0,
          totalBytes: event.data.contentLength ?? null,
        },
      });
      return;
    }
    if (event.event === "Progress") {
      const prev = this.state.progress;
      this.setState({
        progress: {
          downloadedBytes: prev.downloadedBytes + event.data.chunkLength,
          totalBytes: prev.totalBytes,
        },
      });
    }
  }

  beginInstall = async (): Promise<void> => {
    if (this.state.phase !== "downloaded" && this.state.phase !== "error") {
      return;
    }
    const update = this.update;
    if (!update) return;
    this.setState({ phase: "installing", error: null });
    try {
      await update.install();
    } catch (error) {
      this.setState({
        phase: "error",
        error: { phase: "install", message: errorMessage(error) },
      });
      return;
    }
    this.setState({ phase: "ready-to-restart" });
  };

  requestRestart = async (): Promise<void> => {
    if (this.state.phase !== "ready-to-restart") return;
    try {
      await this.deps.relaunch();
    } catch (error) {
      this.setState({
        phase: "error",
        error: { phase: "relaunch", message: errorMessage(error) },
      });
    }
  };

  dismissBanner = (): void => {
    this.setState({ lastDismissedPhase: this.state.phase });
  };

  userCheckForUpdates = (): Promise<void> => {
    if (this.state.lastDismissedPhase !== null) {
      this.setState({ lastDismissedPhase: null });
    }
    return this.checkAndDownload();
  };

  retry = (): Promise<void> => {
    const prev = this.state.error?.phase;
    if (prev === "download" || prev === "check") {
      this.setState({ phase: "idle", error: null });
      return this.checkAndDownload();
    }
    if (prev === "install") {
      this.setState({ phase: "downloaded", error: null });
      return this.beginInstall();
    }
    if (prev === "relaunch") {
      this.setState({ phase: "ready-to-restart", error: null });
      return this.requestRestart();
    }
    return Promise.resolve();
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

export const updaterStore = new UpdaterStore();

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove"] as const;

export interface ScheduleOptions {
  store?: UpdaterStore;
  startupDelayMs?: number;
  intervalMs?: number;
}

export function scheduleUpdateCheck({
  store = updaterStore,
  startupDelayMs = STARTUP_DELAY_MS,
  intervalMs = CHECK_INTERVAL_MS,
}: ScheduleOptions = {}): () => void {
  let lastActivity = Date.now();
  let lastCheck = 0;
  const markActivity = () => {
    lastActivity = Date.now();
  };
  const target = typeof window !== "undefined" ? window : null;
  target?.addEventListener("focus", markActivity);
  for (const name of ACTIVITY_EVENTS) {
    target?.addEventListener(name, markActivity, { passive: true });
  }

  const tick = () => {
    if (lastActivity < lastCheck) return;
    lastCheck = Date.now();
    void store.checkAndDownload();
  };

  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  const startupTimer = setTimeout(() => {
    tick();
    intervalTimer = setInterval(tick, intervalMs);
  }, startupDelayMs);

  return () => {
    clearTimeout(startupTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    target?.removeEventListener("focus", markActivity);
    for (const name of ACTIVITY_EVENTS) {
      target?.removeEventListener(name, markActivity);
    }
  };
}
