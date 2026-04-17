import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import XtermBench from "./XtermBench";
import TerminalWorkspace from "./TerminalWorkspace";
import { getBenchmarkMode, getRendererMode } from "./lib/ipc";
import "./styles/tokens.css";
import "./styles/agent.css";

function Root() {
  const [benchMode, setBenchMode] = useState<string | null | undefined>(undefined);
  const [rendererMode, setRendererMode] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    getBenchmarkMode()
      .then((mode) => setBenchMode(mode))
      .catch(() => setBenchMode(null));
    getRendererMode()
      .then((mode) => setRendererMode(mode))
      .catch(() => setRendererMode(null));
  }, []);

  if (benchMode === undefined || rendererMode === undefined) return null;
  if (benchMode === "xterm") return <XtermBench />;
  return <TerminalWorkspace rendererMode={rendererMode ?? "xterm"} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
