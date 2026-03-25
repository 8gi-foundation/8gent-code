/**
 * Keyboard Shortcut Registry for 8gent TUI
 *
 * Centralised registry of all keyboard shortcuts. Each shortcut has a key combo,
 * description, context (where it applies), and handler signature. The TUI reads
 * this registry to bind keys and render the help overlay.
 *
 * Usage:
 *   import { shortcuts, findShortcut, shortcutsByContext } from './keyboard-shortcuts'
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShortcutContext = 'global' | 'chat' | 'editor' | 'menu';

export interface KeyCombo {
  /** Display label shown in help overlay, e.g. "Ctrl+C" */
  label: string;
  /** Ink useInput key name, e.g. "c" */
  key: string;
  /** Whether Ctrl must be held */
  ctrl?: boolean;
  /** Whether Meta/Alt must be held */
  meta?: boolean;
  /** Whether Shift must be held */
  shift?: boolean;
}

export interface Shortcut {
  id: string;
  combo: KeyCombo;
  description: string;
  /** Contexts where this shortcut is active */
  contexts: ShortcutContext[];
  /** If true the shortcut cannot be rebound by the user */
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const shortcuts: readonly Shortcut[] = [
  {
    id: 'abort',
    combo: { label: 'Ctrl+C', key: 'c', ctrl: true },
    description: 'Abort current generation',
    contexts: ['global'],
    locked: true,
  },
  {
    id: 'exit',
    combo: { label: 'Ctrl+D', key: 'd', ctrl: true },
    description: 'Exit the TUI',
    contexts: ['global'],
    locked: true,
  },
  {
    id: 'clear',
    combo: { label: 'Ctrl+L', key: 'l', ctrl: true },
    description: 'Clear the screen',
    contexts: ['global'],
  },
  {
    id: 'autocomplete',
    combo: { label: 'Tab', key: 'tab' },
    description: 'Trigger autocomplete / accept ghost suggestion',
    contexts: ['chat', 'editor'],
  },
  {
    id: 'history-prev',
    combo: { label: 'Up', key: 'upArrow' },
    description: 'Previous item in history',
    contexts: ['chat'],
  },
  {
    id: 'history-next',
    combo: { label: 'Down', key: 'downArrow' },
    description: 'Next item in history',
    contexts: ['chat'],
  },
  {
    id: 'save-checkpoint',
    combo: { label: 'Ctrl+S', key: 's', ctrl: true },
    description: 'Save a session checkpoint',
    contexts: ['global'],
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up a shortcut by its stable id. */
export function findShortcut(id: string): Shortcut | undefined {
  return shortcuts.find((s) => s.id === id);
}

/** Return all shortcuts active in a given context. */
export function shortcutsByContext(ctx: ShortcutContext): Shortcut[] {
  return shortcuts.filter((s) => s.contexts.includes(ctx));
}

/**
 * Test whether an Ink `useInput` event matches a registered shortcut.
 *
 * @param id      - Shortcut id to test against
 * @param input   - The raw character from useInput
 * @param inkKey  - The key object from useInput
 * @returns true when the event matches the shortcut
 */
export function matchesShortcut(
  id: string,
  input: string,
  inkKey: { ctrl?: boolean; meta?: boolean; shift?: boolean; upArrow?: boolean; downArrow?: boolean; tab?: boolean },
): boolean {
  const sc = findShortcut(id);
  if (!sc) return false;

  const { combo } = sc;

  // Arrow / special keys are surfaced as boolean flags in Ink
  if (combo.key === 'upArrow') return !!inkKey.upArrow;
  if (combo.key === 'downArrow') return !!inkKey.downArrow;
  if (combo.key === 'tab') return !!inkKey.tab;

  // Character keys
  const keyMatch = input === combo.key;
  const ctrlMatch = !!combo.ctrl === !!inkKey.ctrl;
  const metaMatch = !!combo.meta === !!inkKey.meta;
  const shiftMatch = !!combo.shift === !!inkKey.shift;

  return keyMatch && ctrlMatch && metaMatch && shiftMatch;
}

/** Format shortcuts as a help table (plain text). */
export function formatHelpTable(ctx?: ShortcutContext): string {
  const list = ctx ? shortcutsByContext(ctx) : [...shortcuts];
  const maxLabel = Math.max(...list.map((s) => s.combo.label.length));
  return list
    .map((s) => `  ${s.combo.label.padEnd(maxLabel)}  ${s.description}`)
    .join('\n');
}
