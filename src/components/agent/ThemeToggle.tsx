import type { ThemeOverride } from "../../hooks/useThemeOverride";

const LABELS: Record<ThemeOverride, { icon: string; title: string }> = {
  system: { icon: "◐", title: "Theme: follow system (click to pick light)" },
  light: { icon: "☀", title: "Theme: light (click to pick dark)" },
  dark: { icon: "☾", title: "Theme: dark (click to follow system)" },
};

export default function ThemeToggle({
  override,
  onCycle,
}: {
  override: ThemeOverride;
  onCycle: () => void;
}) {
  const label = LABELS[override];
  return (
    <button
      type="button"
      className="agent-theme-toggle"
      onClick={onCycle}
      title={label.title}
      aria-label={label.title}
    >
      {label.icon}
    </button>
  );
}
