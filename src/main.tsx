import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import XtermBench from "./XtermBench";
import TerminalWorkspace from "./TerminalWorkspace";
import { getBenchmarkMode } from "./lib/ipc";
import "./styles/tokens.css";
import "./styles/agent.css";

function Root() {
  const [benchMode, setBenchMode] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    getBenchmarkMode()
      .then((mode) => setBenchMode(mode))
      .catch(() => setBenchMode(null));
  }, []);

  if (benchMode === undefined) return null;
  if (benchMode === "xterm") return <XtermBench />;
  return <TerminalWorkspace />;
}

createRoot(document.getElementById("root")!).render(<Root />);
