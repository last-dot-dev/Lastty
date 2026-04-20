import { useEffect, useState } from "react";

import { materialize, subscribe } from "./ipc";
import type { AppId, DocPatch } from "./types";

export function applyPatch(doc: unknown, patch: DocPatch): unknown {
  const clone = structuredClone(doc ?? {});
  if (patch.op === "put") {
    if (patch.path.length === 0) return patch.value;
    const [parent, key] = walkParent(clone, patch.path);
    (parent as Record<string, unknown>)[key] = patch.value;
    return clone;
  }
  if (patch.op === "insert") {
    if (patch.path.length === 0) return patch.value;
    const arr = walkTo(clone, patch.path) as unknown[];
    if (!Array.isArray(arr)) return clone;
    arr.splice(patch.index, 0, patch.value);
    return clone;
  }
  if (patch.op === "delete") {
    const [parent, key] = walkParent(clone, patch.path);
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return clone;
  }
  return clone;
}

function walkTo(doc: unknown, path: string[]): unknown {
  let cur: unknown = doc;
  for (const p of path) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function walkParent(
  doc: unknown,
  path: string[],
): [Record<string, unknown> | unknown[], string] {
  let cur: unknown = doc;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else cur = (cur as Record<string, unknown>)[p];
  }
  return [cur as Record<string, unknown> | unknown[], path[path.length - 1]];
}

export function useAppDoc(appId: AppId | null): unknown | null {
  const [doc, setDoc] = useState<unknown | null>(null);

  useEffect(() => {
    if (!appId) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const initial = await materialize(appId);
      if (cancelled) return;
      setDoc(initial);
      unlisten = await subscribe(appId, (patch) => {
        setDoc((prev: unknown | null) => applyPatch(prev ?? {}, patch));
      });
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [appId]);

  return doc;
}
