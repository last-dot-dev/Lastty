export function formatRelative(unixSec: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (diffSec < 60) return "<1m";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
