import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import App from "./App";
import XtermBench from "./XtermBench";
import XtermTerminal from "./XtermTerminal";
import { getBenchmarkMode, getRendererMode } from "./lib/ipc";

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
  if (rendererMode === "xterm") return <XtermTerminal />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(<Root />);
