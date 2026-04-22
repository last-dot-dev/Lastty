export function basename(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function parentPath(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return "";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

export function isValidCloneUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return trimmed.length > "https://".length;
  }
  if (trimmed.startsWith("ssh://") || trimmed.startsWith("git://")) {
    return trimmed.length > "ssh://".length;
  }
  if (trimmed.startsWith("git@")) {
    const rest = trimmed.slice("git@".length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx <= 0) return false;
    return colonIdx < rest.length - 1;
  }
  return false;
}

export function previewRepoName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
  const tail = lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
  const withoutGit = tail.endsWith(".git") ? tail.slice(0, -".git".length) : tail;
  if (
    !withoutGit ||
    withoutGit === "." ||
    withoutGit === ".." ||
    withoutGit.includes("/") ||
    withoutGit.includes("\\")
  ) {
    return "";
  }
  return withoutGit;
}
