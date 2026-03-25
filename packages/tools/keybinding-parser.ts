/**
 * keybinding-parser.ts
 * Parses keyboard shortcut strings into structured key combinations.
 * Supports cross-platform normalization (cmd vs ctrl) and event matching.
 */

export interface KeyBinding {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

export interface KeyEvent {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  key?: string;
  code?: string;
}

const MODIFIER_MAP: Record<string, keyof Omit<KeyBinding, "key">> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
};

const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  " ": "space",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};

/**
 * Parse a shortcut string like "ctrl+shift+a" into a KeyBinding struct.
 * Modifiers are case-insensitive. Key is lowercased.
 */
export function parse(shortcut: string): KeyBinding {
  const parts = shortcut
    .toLowerCase()
    .split(/[+\-]/)
    .map((p) => p.trim())
    .filter(Boolean);

  const binding: KeyBinding = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: "",
  };

  for (const part of parts) {
    const modifier = MODIFIER_MAP[part];
    if (modifier) {
      binding[modifier] = true;
    } else {
      binding.key = KEY_ALIASES[part] ?? part;
    }
  }

  if (!binding.key) {
    throw new Error(`keybinding-parser: no key found in shortcut "${shortcut}"`);
  }

  return binding;
}

/**
 * Check if a browser/terminal KeyEvent matches a parsed KeyBinding.
 */
export function matches(event: KeyEvent, binding: KeyBinding): boolean {
  const eventKey = (event.key ?? "").toLowerCase();
  const normalizedKey = KEY_ALIASES[eventKey] ?? eventKey;

  return (
    !!event.ctrlKey === binding.ctrl &&
    !!event.shiftKey === binding.shift &&
    !!event.altKey === binding.alt &&
    !!event.metaKey === binding.meta &&
    normalizedKey === binding.key
  );
}

/**
 * Format a KeyBinding into a human-readable string, e.g. "Ctrl+Shift+A".
 */
export function format(binding: KeyBinding): string {
  const parts: string[] = [];

  if (binding.ctrl) parts.push("Ctrl");
  if (binding.shift) parts.push("Shift");
  if (binding.alt) parts.push("Alt");
  if (binding.meta) parts.push("Meta");

  const key = binding.key.length === 1
    ? binding.key.toUpperCase()
    : binding.key.charAt(0).toUpperCase() + binding.key.slice(1);

  parts.push(key);

  return parts.join("+");
}

/**
 * Normalize a KeyBinding for cross-platform use.
 * On macOS, "ctrl" is remapped to "meta" (Cmd) for common shortcuts.
 * Pass platform = "mac" | "other". Defaults to "other".
 */
export function normalize(
  binding: KeyBinding,
  platform: "mac" | "other" = "other"
): KeyBinding {
  if (platform !== "mac") return { ...binding };

  // On macOS, Ctrl+Key shortcuts are conventionally Cmd+Key
  if (binding.ctrl && !binding.meta) {
    return { ...binding, ctrl: false, meta: true };
  }

  return { ...binding };
}
