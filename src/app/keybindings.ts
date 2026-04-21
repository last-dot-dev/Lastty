export type Platform = "mac" | "other";

export type KeyboardMode = "standard" | "tmux";

export type ModifierScheme = "platform" | "ctrl" | "none";

export interface KeySpec {
  key: string;
  matchKeys?: string[];
  shift?: boolean;
  modifiers?: ModifierScheme;
  allowCtrl?: boolean;
}

export interface Shortcut {
  sequence: KeySpec[];
  modes?: KeyboardMode[];
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
  shortcuts: Shortcut[];
  category: Category;
  label: string;
  payload?: number;
}

export interface BindingMatch {
  binding: Binding;
  shortcut: Shortcut;
}

export interface PendingBinding {
  binding: Binding;
  shortcut: Shortcut;
  nextIndex: number;
  expiresAtMs: number;
}

export interface BindingResolution {
  match: BindingMatch | null;
  pending: PendingBinding[];
  capture: boolean;
}

const ALL_MODES: KeyboardMode[] = ["standard", "tmux"];
const TMUX_ONLY: KeyboardMode[] = ["tmux"];
const PREFIX_TIMEOUT_MS = 1_500;

export const DEFAULT_KEYBOARD_MODE: KeyboardMode = "standard";

export const BINDINGS: Binding[] = [
  {
    id: "focus.left",
    shortcuts: [
      { sequence: [{ key: "h" }], modes: ALL_MODES },
      { sequence: [{ key: "ArrowLeft" }], modes: ALL_MODES },
      { sequence: [{ key: "h", modifiers: "ctrl" }], modes: TMUX_ONLY },
    ],
    category: "Navigation",
    label: "Focus pane left",
  },
  {
    id: "focus.down",
    shortcuts: [
      { sequence: [{ key: "j" }], modes: ALL_MODES },
      { sequence: [{ key: "ArrowDown" }], modes: ALL_MODES },
      { sequence: [{ key: "j", modifiers: "ctrl" }], modes: TMUX_ONLY },
    ],
    category: "Navigation",
    label: "Focus pane down",
  },
  {
    id: "focus.up",
    shortcuts: [
      { sequence: [{ key: "k" }], modes: ALL_MODES },
      { sequence: [{ key: "ArrowUp" }], modes: ALL_MODES },
      { sequence: [{ key: "k", modifiers: "ctrl" }], modes: TMUX_ONLY },
    ],
    category: "Navigation",
    label: "Focus pane up",
  },
  {
    id: "focus.right",
    shortcuts: [
      { sequence: [{ key: "l" }], modes: ALL_MODES },
      { sequence: [{ key: "ArrowRight" }], modes: ALL_MODES },
      { sequence: [{ key: "l", modifiers: "ctrl" }], modes: TMUX_ONLY },
    ],
    category: "Navigation",
    label: "Focus pane right",
  },
  {
    id: "pane.split.horizontal",
    shortcuts: [
      { sequence: [{ key: "s" }], modes: ALL_MODES },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          {
            key: "|",
            matchKeys: ["|", "\\"],
            shift: true,
            modifiers: "none",
            allowCtrl: true,
          },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Panes",
    label: "Split pane right",
  },
  {
    id: "pane.split.vertical",
    shortcuts: [
      { sequence: [{ key: "v" }], modes: ALL_MODES },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          { key: "-", modifiers: "none", allowCtrl: true },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Panes",
    label: "Split pane below",
  },
  {
    id: "pane.close",
    shortcuts: [
      { sequence: [{ key: "c" }], modes: ALL_MODES },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          { key: "x", modifiers: "none", allowCtrl: true },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Panes",
    label: "Close focused pane",
  },
  {
    id: "agent.launch",
    shortcuts: [{ sequence: [{ key: "a" }], modes: ALL_MODES }],
    category: "Panes",
    label: "Launch agent",
  },
  {
    id: "desktop.new",
    shortcuts: [
      { sequence: [{ key: "t" }], modes: ALL_MODES },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          { key: "c", modifiers: "none", allowCtrl: true },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Desktops",
    label: "New desktop",
  },
  {
    id: "desktop.next",
    shortcuts: [
      { sequence: [{ key: "]" }], modes: ALL_MODES },
      { sequence: [{ key: "Tab", modifiers: "ctrl" }], modes: ALL_MODES },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          {
            key: ">",
            matchKeys: [">", "."],
            shift: true,
            modifiers: "none",
            allowCtrl: true,
          },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Desktops",
    label: "Next desktop",
  },
  {
    id: "desktop.prev",
    shortcuts: [
      { sequence: [{ key: "[" }], modes: ALL_MODES },
      {
        sequence: [{ key: "Tab", shift: true, modifiers: "ctrl" }],
        modes: ALL_MODES,
      },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          {
            key: "<",
            matchKeys: ["<", ","],
            shift: true,
            modifiers: "none",
            allowCtrl: true,
          },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Desktops",
    label: "Previous desktop",
  },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map<Binding>((n) => ({
    id: "desktop.jump",
    shortcuts: [
      { sequence: [{ key: String(n) }], modes: ALL_MODES },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          { key: String(n), modifiers: "none", allowCtrl: true },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Desktops",
    label: `Jump to desktop ${n}`,
    payload: n,
  })),
  {
    id: "help.toggle",
    shortcuts: [
      { sequence: [{ key: "/" }], modes: ALL_MODES },
      {
        sequence: [
          { key: "a", modifiers: "ctrl" },
          {
            key: "?",
            matchKeys: ["?", "/"],
            shift: true,
            modifiers: "none",
            allowCtrl: true,
          },
        ],
        modes: TMUX_ONLY,
      },
    ],
    category: "Help",
    label: "Show keyboard shortcuts",
  },
];

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const haystack = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(haystack) ? "mac" : "other";
}

export function bindingsForMode(mode: KeyboardMode): Binding[] {
  return BINDINGS.flatMap((binding) => {
    const shortcuts = binding.shortcuts.filter((shortcut) => shortcutSupportsMode(shortcut, mode));
    if (shortcuts.length === 0) return [];
    return [{ ...binding, shortcuts }];
  });
}

export function describeKeyboardMode(mode: KeyboardMode, platform: Platform): string {
  if (mode === "tmux") {
    return "Standard shortcuts plus tmux-style prefix sequences and Ctrl+H/J/K/L pane focus";
  }
  return platform === "mac" ? "⌘⌃ + key" : "Ctrl+Shift + key";
}

export function matchBinding(
  event: KeyboardEvent,
  platform: Platform,
  mode: KeyboardMode,
  pending: PendingBinding[] = [],
  now = Date.now(),
): BindingResolution {
  const activePending = pending.filter((entry) => entry.expiresAtMs > now);
  for (const entry of activePending) {
    const nextSpec = entry.shortcut.sequence[entry.nextIndex];
    if (!nextSpec || !keySpecMatches(event, platform, nextSpec)) continue;
    if (entry.nextIndex >= entry.shortcut.sequence.length - 1) {
      return {
        match: { binding: entry.binding, shortcut: entry.shortcut },
        pending: [],
        capture: true,
      };
    }
  }

  const nextPending: PendingBinding[] = [];
  for (const binding of bindingsForMode(mode)) {
    for (const shortcut of binding.shortcuts) {
      const [firstStep] = shortcut.sequence;
      if (!firstStep || !keySpecMatches(event, platform, firstStep)) continue;
      if (shortcut.sequence.length === 1) {
        return {
          match: { binding, shortcut },
          pending: [],
          capture: true,
        };
      }
      nextPending.push({
        binding,
        shortcut,
        nextIndex: 1,
        expiresAtMs: now + PREFIX_TIMEOUT_MS,
      });
    }
  }

  if (nextPending.length > 0) {
    return { match: null, pending: nextPending, capture: true };
  }
  return { match: null, pending: [], capture: false };
}

export function formatShortcut(shortcut: Shortcut, platform: Platform): string[] {
  return shortcut.sequence.map((spec) => formatKey(spec, platform));
}

export function formatKey(spec: KeySpec, platform: Platform): string {
  const keyLabel = formatKeyLabel(spec.key);
  if (spec.modifiers === "none") {
    if (!spec.shift) return keyLabel;
    return platform === "mac" ? `⇧${keyLabel}` : `Shift+${keyLabel}`;
  }
  if (spec.modifiers === "ctrl") {
    if (platform === "mac") return spec.shift ? `⌃⇧${keyLabel}` : `⌃${keyLabel}`;
    return spec.shift ? `Ctrl+Shift+${keyLabel}` : `Ctrl+${keyLabel}`;
  }
  if (platform === "mac") return `⌘⌃${keyLabel}`;
  return `Ctrl+Shift+${keyLabel}`;
}

function shortcutSupportsMode(shortcut: Shortcut, mode: KeyboardMode): boolean {
  return shortcut.modes ? shortcut.modes.includes(mode) : true;
}

function keyMatches(eventKey: string, specKey: string): boolean {
  if (specKey.length === 1) {
    return eventKey.toLowerCase() === specKey.toLowerCase();
  }
  return eventKey === specKey;
}

function keySpecMatches(event: KeyboardEvent, platform: Platform, spec: KeySpec): boolean {
  const candidateKeys = spec.matchKeys ?? [spec.key];
  if (!candidateKeys.some((key) => keyMatches(event.key, key))) return false;
  return specModifiersMatch(event, platform, spec);
}

function specModifiersMatch(event: KeyboardEvent, platform: Platform, spec: KeySpec): boolean {
  if (spec.modifiers === "none") {
    return (
      (spec.allowCtrl === true || event.ctrlKey === false) &&
      event.metaKey === false &&
      event.altKey === false &&
      event.shiftKey === (spec.shift === true)
    );
  }
  if (spec.modifiers === "ctrl") {
    if (!event.ctrlKey || event.metaKey || event.altKey) return false;
    return event.shiftKey === (spec.shift === true);
  }
  if (platform === "mac") {
    return event.metaKey === true && event.ctrlKey === true && event.altKey === false;
  }
  return event.ctrlKey === true && event.shiftKey === true && event.altKey === false && event.metaKey === false;
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
