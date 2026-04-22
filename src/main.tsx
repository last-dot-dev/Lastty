import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import XtermBench from "./XtermBench";
import TerminalWorkspace from "./TerminalWorkspace";
import { getBenchmarkMode } from "./lib/ipc";
import { scheduleUpdateCheck, updaterStore } from "./lib/updater";
import "./styles/tokens.css";
import "./styles/agent.css";

scheduleUpdateCheck();

void listen("menu://check-for-updates", () => {
  void updaterStore.userCheckForUpdates();
});

function Root() {
  const [benchMode, setBenchMode] = useState<string | null | undefined>(
    __LASTTY_BENCH__ ? undefined : null,
  );

  useEffect(() => {
    if (!__LASTTY_BENCH__) return;
    getBenchmarkMode()
      .then((mode) => setBenchMode(mode))
      .catch(() => setBenchMode(null));
  }, []);

  if (__LASTTY_BENCH__) {
    if (benchMode === undefined) return null;
    if (benchMode === "xterm") return <XtermBench />;
  }
  return <TerminalWorkspace />;
}

createRoot(document.getElementById("root")!).render(<Root />);
