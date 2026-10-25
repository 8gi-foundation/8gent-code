/**
 * A scoped model list (#3918 D3): the few models a person flips between with
 * one key, out of everything the provider lists. /scoped-models sets it;
 * Alt+M cycles it (the full list when no scope is set).
 */

export interface ScopeResolution {
	/** Models in the scope, in the order given, no duplicates. */
	scope: string[];
	/** Arguments that matched nothing the provider lists. */
	unknown: string[];
}

/**
 * Turn /scoped-models arguments into a scope. Each argument is an exact
 * model id, or a case-insensitive substring that may match several ids.
 * "clear", "all" or "none" empties the scope.
 */
export function resolveScope(
	args: readonly string[],
	available: readonly string[],
): ScopeResolution {
	const scope: string[] = [];
	const unknown: string[] = [];
	const add = (m: string) => {
		if (!scope.includes(m)) scope.push(m);
	};
	for (const raw of args) {
		const arg = raw.trim();
		if (!arg) continue;
		if (["clear", "all", "none"].includes(arg.toLowerCase())) return { scope: [], unknown: [] };
		if (available.includes(arg)) {
			add(arg);
			continue;
		}
		const needle = arg.toLowerCase();
		const hits = available.filter((m) => m.toLowerCase().includes(needle));
		if (hits.length === 0) unknown.push(arg);
		for (const h of hits) add(h);
	}
	return { scope, unknown };
}

/** The model after `current` in `list`, wrapping; the first when `current` is not listed. */
export function nextModel(list: readonly string[], current: string): string | null {
	if (list.length === 0) return null;
	const i = list.indexOf(current);
	return list[(i + 1) % list.length] ?? null;
}

/** The /scoped-models text with no arguments. */
export function describeScope(scope: readonly string[], available: readonly string[]): string {
	if (scope.length === 0) {
		return `No scope set: Alt+M cycles all ${available.length} listed models.\nSet one: /scoped-models <model or part of a name> ...`;
	}
	return `Scoped models (Alt+M cycles them):\n${scope.map((m) => `  ${m}`).join("\n")}\nClear: /scoped-models clear`;
}
