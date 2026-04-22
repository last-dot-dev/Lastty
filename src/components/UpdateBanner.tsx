import { useCallback, useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  UpdaterStore,
  updaterStore as defaultStore,
  type UpdaterState,
} from "../lib/updater";

export interface UpdateBannerProps {
  activeSessionCount?: number;
  store?: UpdaterStore;
}

export function shouldShowBanner(state: UpdaterState): boolean {
  if (state.lastDismissedPhase === state.phase) return false;
  return (
    state.phase === "downloaded" ||
    state.phase === "ready-to-restart" ||
    state.phase === "error"
  );
}

export default function UpdateBanner({
  activeSessionCount = 0,
  store = defaultStore,
}: UpdateBannerProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);

  const onPrimary = useCallback(() => {
    if (state.phase === "ready-to-restart") void store.requestRestart();
    else if (state.phase === "downloaded") void store.beginInstall();
    else if (state.phase === "error") void store.retry();
  }, [state.phase, store]);

  const onDismiss = useCallback(() => {
    store.dismissBanner();
  }, [store]);

  if (!shouldShowBanner(state)) return null;

  const version = state.version ?? "";
  const isError = state.phase === "error";

  let message: string;
  let primaryLabel: string;
  if (state.phase === "ready-to-restart") {
    const sessionNote =
      activeSessionCount > 0
        ? ` ${activeSessionCount} active session${activeSessionCount === 1 ? "" : "s"} will end.`
        : "";
    message = `A new version of Lastty${version ? ` (v${version})` : ""} is ready. Restart to update.${sessionNote}`;
    primaryLabel = "Restart";
  } else if (state.phase === "downloaded") {
    message = `A new version of Lastty${version ? ` (v${version})` : ""} is downloaded. Install to continue.`;
    primaryLabel = "Install";
  } else {
    message = `Update failed: ${state.error?.message ?? "unknown error"}`;
    primaryLabel = "Retry";
  }

  return (
    <div
      className="agent-update-banner"
      data-phase={state.phase}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      <span
        className="agent-dot"
        style={{
          background: isError
            ? "var(--color-text-danger)"
            : "var(--status-help-dot)",
        }}
      />
      <span className="agent-update-banner__message">{message}</span>
      {!isError && state.releaseNotesUrl && (
        <button
          type="button"
          className="agent-update-banner__link"
          onClick={() => {
            void openUrl(state.releaseNotesUrl!);
          }}
        >
          Release notes
        </button>
      )}
      <button
        type="button"
        className="agent-update-banner__action"
        onClick={onPrimary}
      >
        {primaryLabel}
      </button>
      <button
        type="button"
        className="agent-update-banner__dismiss"
        aria-label="Dismiss update notice"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
