import type { ThemeOverride } from "../../hooks/useThemeOverride";

export default function ThemeToggle({
  override,
  effective,
  onCycle,
}: {
  override: ThemeOverride;
  effective: "light" | "dark";
  onCycle: () => void;
}) {
  const icon = override === "system" ? "◐" : effective === "light" ? "☀" : "☾";
  const next = effective === "light" ? "dark" : "light";
  const title =
    override === "system"
      ? `Theme: follow system (currently ${effective}, click to switch to ${next})`
      : `Theme: ${effective} (click to switch to ${next})`;
  return (
    <button
      type="button"
      className="agent-theme-toggle"
      onClick={onCycle}
      title={title}
      aria-label={title}
    >
      {icon}
    </button>
  );
}
