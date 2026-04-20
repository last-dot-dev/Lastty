import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  UpdaterStore,
  updaterStore as defaultStore,
  type UpdaterState,
} from "../lib/updater";

export interface UpdateBadgeProps {
  activeSessionCount?: number;
  store?: UpdaterStore;
}

export default function UpdateBadge({
  activeSessionCount = 0,
  store = defaultStore,
}: UpdateBadgeProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (state.phase === "idle") setOpen(false);
  }, [state.phase]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (state.phase === "idle") return null;

  const { label, indicator, interactive } = describe(state);

  return (
    <div className="update-badge" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-label={label}
        className={`update-badge__button update-badge__button--${state.phase}`}
        disabled={!interactive}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <span className={`update-badge__indicator update-badge__indicator--${indicator}`} />
        {state.phase === "ready-to-restart" && (
          <span className="update-badge__label">Restart</span>
        )}
      </button>
      {open && interactive && (
        <UpdateBadgePopover
          state={state}
          activeSessionCount={activeSessionCount}
          store={store}
          onDismiss={() => setOpen(false)}
        />
      )}
    </div>
  );
}

interface PopoverProps {
  state: UpdaterState;
  activeSessionCount: number;
  store: UpdaterStore;
  onDismiss: () => void;
}

function UpdateBadgePopover({
  state,
  activeSessionCount,
  store,
  onDismiss,
}: PopoverProps) {
  const install = useCallback(() => {
    void store.beginInstall();
  }, [store]);
  const restart = useCallback(() => {
    void store.requestRestart();
  }, [store]);
  const retry = useCallback(() => {
    void store.retry();
  }, [store]);

  const version = state.version ?? "";

  if (state.phase === "downloading") {
    return (
      <div className="update-badge__popover" role="dialog">
        <div className="update-badge__title">Downloading v{version}</div>
        <ProgressBar progress={state.progress} />
        {state.releaseNotesUrl && (
          <a
            className="update-badge__link"
            href={state.releaseNotesUrl}
            rel="noreferrer"
            target="_blank"
          >
            Release notes
          </a>
        )}
      </div>
    );
  }

  if (state.phase === "downloaded") {
    return (
      <div className="update-badge__popover" role="dialog">
        <div className="update-badge__title">v{version} ready to install</div>
        <div className="update-badge__body">
          Install extracts the new app bundle. You'll still be asked before restarting.
        </div>
        <div className="update-badge__actions">
          {state.releaseNotesUrl && (
            <a
              className="update-badge__link"
              href={state.releaseNotesUrl}
              rel="noreferrer"
              target="_blank"
            >
              Release notes
            </a>
          )}
          <button
            className="update-badge__action update-badge__action--primary"
            onClick={install}
            type="button"
          >
            Install
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "ready-to-restart") {
    const warn = activeSessionCount > 0;
    return (
      <div className="update-badge__popover" role="dialog">
        <div className="update-badge__title">Restart to finish v{version}</div>
        <div className="update-badge__body">
          {warn
            ? `${activeSessionCount} terminal session${activeSessionCount === 1 ? "" : "s"} ${activeSessionCount === 1 ? "is" : "are"} active. Restarting will end them. Save your work before continuing.`
            : "The new version is staged on disk. Restart now or on next launch."}
        </div>
        <div className="update-badge__actions">
          <button
            className="update-badge__action"
            onClick={onDismiss}
            type="button"
          >
            Later
          </button>
          <button
            className="update-badge__action update-badge__action--primary"
            onClick={restart}
            type="button"
          >
            Restart
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="update-badge__popover" role="dialog">
        <div className="update-badge__title">Update failed</div>
        <div className="update-badge__body">
          {state.error?.message ?? "Couldn't check for updates."}
        </div>
        <div className="update-badge__actions">
          <button
            className="update-badge__action update-badge__action--primary"
            onClick={retry}
            type="button"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return null;
}

function ProgressBar({ progress }: { progress: UpdaterState["progress"] }) {
  const pct = useMemo(() => {
    if (!progress.totalBytes || progress.totalBytes <= 0) return null;
    return Math.min(
      100,
      Math.round((progress.downloadedBytes / progress.totalBytes) * 100),
    );
  }, [progress.downloadedBytes, progress.totalBytes]);
  return (
    <div className="update-badge__progress">
      <div
        className={`update-badge__progress-bar${pct === null ? " update-badge__progress-bar--indeterminate" : ""}`}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
      <div className="update-badge__progress-label">
        {pct === null ? "Downloading…" : `${pct}%`}
      </div>
    </div>
  );
}

interface Describe {
  label: string;
  indicator: "spinner" | "ready" | "pulse" | "error";
  interactive: boolean;
}

function describe(state: UpdaterState): Describe {
  switch (state.phase) {
    case "downloading":
      return {
        label: `Downloading update v${state.version ?? ""}`,
        indicator: "spinner",
        interactive: true,
      };
    case "downloaded":
      return {
        label: `Update v${state.version ?? ""} ready to install`,
        indicator: "ready",
        interactive: true,
      };
    case "installing":
      return {
        label: "Installing update",
        indicator: "spinner",
        interactive: false,
      };
    case "ready-to-restart":
      return {
        label: `Restart to finish updating to v${state.version ?? ""}`,
        indicator: "pulse",
        interactive: true,
      };
    case "error":
      return {
        label: "Update failed",
        indicator: "error",
        interactive: true,
      };
    case "idle":
    default:
      return { label: "", indicator: "spinner", interactive: false };
  }
}
