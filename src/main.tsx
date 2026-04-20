import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import XtermBench from "./XtermBench";
import TerminalWorkspace from "./TerminalWorkspace";
import { SubstrateWorkspace } from "./substrate/SubstrateWorkspace";
import { getBenchmarkMode } from "./lib/ipc";
import { scheduleUpdateCheck } from "./lib/updater";
import "./styles/tokens.css";
import "./styles/agent.css";

scheduleUpdateCheck();

function useHashRoute() {
  const [hash, setHash] = useState<string>(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Root() {
  const [benchMode, setBenchMode] = useState<string | null | undefined>(undefined);
  const hash = useHashRoute();

  useEffect(() => {
    getBenchmarkMode()
      .then((mode) => setBenchMode(mode))
      .catch(() => setBenchMode(null));
  }, []);

  if (benchMode === undefined) return null;
  if (benchMode === "xterm") return <XtermBench />;
  if (hash === "#substrate") return <SubstrateWorkspace />;
  return (
    <>
      <TerminalWorkspace />
      <a
        href="#substrate"
        onClick={(e) => {
          e.preventDefault();
          window.location.hash = "substrate";
        }}
        style={{
          position: "fixed",
          top: 6,
          right: 10,
          zIndex: 9999,
          fontSize: 10,
          color: "#6af",
          background: "rgba(10,10,16,0.7)",
          padding: "3px 8px",
          borderRadius: 4,
          textDecoration: "none",
          border: "1px solid #2d5fa3",
          fontFamily: "system-ui",
        }}
      >
        substrate
      </a>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
