import { check } from "@tauri-apps/plugin-updater";

const STARTUP_DELAY_MS = 10_000;

export function scheduleUpdateCheck() {
  setTimeout(() => {
    void runUpdateCheck();
  }, STARTUP_DELAY_MS);
}

async function runUpdateCheck() {
  try {
    const update = await check();
    if (!update) {
      console.log("[updater] no update available");
      return;
    }
    // TODO: surface this in-app via a dedicated update-available UI so the
    // user can trigger download + relaunch; for v0.1.0 we only log.
    console.log(
      `[updater] update available: ${update.version} (current ${update.currentVersion})`,
      update.date ? `released ${update.date}` : "",
    );
  } catch (error) {
    console.warn("[updater] update check failed", error);
  }
}
