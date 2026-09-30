/**
 * State updater for polls: keep the previous value when the new one holds
 * the same data. A poll that sets a fresh object or array every tick
 * re-renders its component every tick, and every React commit makes Ink
 * lay out and rewrite the whole screen - on an idle TUI, for nothing.
 *
 * Equality is structural via JSON, which suits the plain poll data it is
 * used for (task lists, counts, player status). Not for values with
 * functions, Maps, or cycles.
 */
export function keepIfSame<T>(next: T): (prev: T) => T {
	return (prev) => (prev === next || JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
}
