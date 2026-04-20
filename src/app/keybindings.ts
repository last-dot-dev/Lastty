export type Platform = "mac" | "other";

export type ModifierScheme = "platform" | "ctrl";

export interface KeySpec {
  key: string;
  shift?: boolean;
  modifiers?: ModifierScheme;
}

export type ActionId =
  | "focus.left"
  | "focus.down"
  | "focus.up"
  | "focus.right"
  | "pane.split.horizontal"
  | "pane.split.vertical"
  | "pane.close"
  | "agent.launch"
  | "desktop.new"
  | "desktop.next"
  | "desktop.prev"
  | "desktop.jump"
  | "help.toggle";

export type Category = "Navigation" | "Panes" | "Desktops" | "Help";

export interface Binding {
  id: ActionId;
  keys: KeySpec[];
  category: Category;
  label: string;
  payload?: number;
}

export interface BindingMatch {
  binding: Binding;
  spec: KeySpec;
}

export const BINDINGS: Binding[] = [
  {
    id: "focus.left",
    keys: [{ key: "h" }, { key: "ArrowLeft" }],
    category: "Navigation",
    label: "Focus pane left",
  },
  {
    id: "focus.down",
    keys: [{ key: "j" }, { key: "ArrowDown" }],
    category: "Navigation",
    label: "Focus pane down",
  },
  {
    id: "focus.up",
    keys: [{ key: "k" }, { key: "ArrowUp" }],
    category: "Navigation",
    label: "Focus pane up",
  },
  {
    id: "focus.right",
    keys: [{ key: "l" }, { key: "ArrowRight" }],
    category: "Navigation",
    label: "Focus pane right",
  },
  {
    id: "pane.split.horizontal",
    keys: [{ key: "s" }],
    category: "Panes",
    label: "Split pane (stacked)",
  },
  {
    id: "pane.split.vertical",
    keys: [{ key: "v" }],
    category: "Panes",
    label: "Split pane (side by side)",
  },
  {
    id: "pane.close",
    keys: [{ key: "c" }],
    category: "Panes",
    label: "Close focused pane",
  },
  {
    id: "agent.launch",
    keys: [{ key: "a" }],
    category: "Panes",
    label: "Launch agent",
  },
  {
    id: "desktop.new",
    keys: [{ key: "t" }],
    category: "Desktops",
    label: "New desktop",
  },
  {
    id: "desktop.next",
    keys: [{ key: "]" }, { key: "Tab", modifiers: "ctrl" }],
    category: "Desktops",
    label: "Next desktop",
  },
  {
    id: "desktop.prev",
    keys: [{ key: "[" }, { key: "Tab", shift: true, modifiers: "ctrl" }],
    category: "Desktops",
    label: "Previous desktop",
  },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map<Binding>((n) => ({
    id: "desktop.jump",
    keys: [{ key: String(n) }],
    category: "Desktops",
    label: `Jump to desktop ${n}`,
    payload: n,
  })),
  {
    id: "help.toggle",
    keys: [{ key: "/" }],
    category: "Help",
    label: "Show keyboard shortcuts",
  },
];

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const haystack = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(haystack) ? "mac" : "other";
}

function keyMatches(eventKey: string, specKey: string): boolean {
  if (specKey.length === 1) {
    return eventKey.toLowerCase() === specKey.toLowerCase();
  }
  return eventKey === specKey;
}

function specModifiersMatch(event: KeyboardEvent, platform: Platform, spec: KeySpec): boolean {
  if (spec.modifiers === "ctrl") {
    if (!event.ctrlKey || event.metaKey || event.altKey) return false;
    return event.shiftKey === (spec.shift === true);
  }
  if (platform === "mac") {
    return event.metaKey === true && event.ctrlKey === true && event.altKey === false;
  }
  return event.ctrlKey === true && event.shiftKey === true && event.altKey === false && event.metaKey === false;
}

export function matchBinding(event: KeyboardEvent, platform: Platform): BindingMatch | null {
  for (const binding of BINDINGS) {
    for (const spec of binding.keys) {
      if (!keyMatches(event.key, spec.key)) continue;
      if (!specModifiersMatch(event, platform, spec)) continue;
      return { binding, spec };
    }
  }
  return null;
}

export function formatKey(spec: KeySpec, platform: Platform): string {
  const keyLabel = formatKeyLabel(spec.key);
  if (spec.modifiers === "ctrl") {
    if (platform === "mac") return spec.shift ? `⌃⇧${keyLabel}` : `⌃${keyLabel}`;
    return spec.shift ? `Ctrl+Shift+${keyLabel}` : `Ctrl+${keyLabel}`;
  }
  if (platform === "mac") return `⌘⌃${keyLabel}`;
  return `Ctrl+Shift+${keyLabel}`;
}

function formatKeyLabel(key: string): string {
  switch (key) {
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "Tab":
      return "⇥";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}
