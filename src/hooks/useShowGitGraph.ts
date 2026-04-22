import { useCallback, useEffect, useState } from "react";

const KEY = "lastty:show-git-graph";

function read(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(KEY) === "1";
}

export function useShowGitGraph() {
  const [show, setShowState] = useState<boolean>(() => read());

  useEffect(() => {
    if (show) {
      window.localStorage.setItem(KEY, "1");
    } else {
      window.localStorage.removeItem(KEY);
    }
  }, [show]);

  const setShow = useCallback((value: boolean) => setShowState(value), []);

  return { show, setShow };
}
