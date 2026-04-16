import { useCallback, useEffect, useState } from "react";

export type ThemeOverride = "light" | "dark" | "system";

const STORAGE_KEY = "lastty:theme";

function readStored(): ThemeOverride {
  if (typeof window === "undefined") return "system";
  const value = window.localStorage.getItem(STORAGE_KEY);
  if (value === "light" || value === "dark") return value;
  return "system";
}

function applyTheme(override: ThemeOverride) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (override === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", override);
  }
}

function resolveEffective(override: ThemeOverride): "light" | "dark" {
  if (override !== "system") return override;
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function useEffectiveTheme(): "light" | "dark" {
  const [value, setValue] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light";
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    return resolveEffective("system");
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;

    const compute = () => {
      const explicit = root.getAttribute("data-theme");
      if (explicit === "light" || explicit === "dark") {
        setValue(explicit);
        return;
      }
      setValue(resolveEffective("system"));
    };

    const observer = new MutationObserver(compute);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const mediaListener = () => compute();
    media?.addEventListener("change", mediaListener);

    return () => {
      observer.disconnect();
      media?.removeEventListener("change", mediaListener);
    };
  }, []);

  return value;
}

export function useThemeOverride() {
  const [override, setOverrideState] = useState<ThemeOverride>(() => readStored());
  const [effective, setEffective] = useState<"light" | "dark">(() =>
    resolveEffective(readStored()),
  );

  useEffect(() => {
    applyTheme(override);
    setEffective(resolveEffective(override));
    if (override === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, override);
    }
  }, [override]);

  useEffect(() => {
    if (override !== "system" || typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setEffective(media.matches ? "dark" : "light");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [override]);

  const setOverride = useCallback((next: ThemeOverride) => {
    setOverrideState(next);
  }, []);

  const cycle = useCallback(() => {
    setOverrideState((current) =>
      current === "system" ? "light" : current === "light" ? "dark" : "system",
    );
  }, []);

  return { override, effective, setOverride, cycle };
}
