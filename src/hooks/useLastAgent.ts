import { useCallback, useState } from "react";

const STORAGE_KEY = "lastty:last-agent-id";

function readStored(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function useLastAgent() {
  const [lastAgentId, setLastAgentIdState] = useState<string | null>(() =>
    readStored(),
  );

  const setLastAgentId = useCallback((id: string | null) => {
    if (id === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
    setLastAgentIdState(id);
  }, []);

  return { lastAgentId, setLastAgentId };
}
