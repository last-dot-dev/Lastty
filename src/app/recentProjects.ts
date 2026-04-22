const STORAGE_KEY = "lastty.recentProjects.v1";
const MAX_ENTRIES = 20;

export interface RecentProject {
  path: string;
  lastUsedMs: number;
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "getItem" | "setItem">;

function canonicalize(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length === 0 ? path : trimmed;
}

function safeParse(raw: string | null): RecentProject[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RecentProject[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as RecentProject).path === "string" &&
        typeof (entry as RecentProject).lastUsedMs === "number"
      ) {
        out.push({
          path: (entry as RecentProject).path,
          lastUsedMs: (entry as RecentProject).lastUsedMs,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function getRecentProjects(
  storage: ReadableStorage = window.localStorage,
): RecentProject[] {
  return safeParse(storage.getItem(STORAGE_KEY));
}

export function pushRecentProject(
  path: string,
  nowMs: number = Date.now(),
  storage: WritableStorage = window.localStorage,
): void {
  const canonical = canonicalize(path);
  if (canonical.length === 0) return;
  const current = getRecentProjects(storage).filter(
    (entry) => entry.path !== canonical,
  );
  const next: RecentProject[] = [
    { path: canonical, lastUsedMs: nowMs },
    ...current,
  ].slice(0, MAX_ENTRIES);
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function removeRecentProject(
  path: string,
  storage: WritableStorage = window.localStorage,
): void {
  const canonical = canonicalize(path);
  const next = getRecentProjects(storage).filter(
    (entry) => entry.path !== canonical,
  );
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
}
