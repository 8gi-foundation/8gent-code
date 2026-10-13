/**
 * Slash dispatch coverage: which registry names have no handler in the given
 * source text. A handler is a switch case, a `command === "x"` comparison
 * (with optional cast/parens), or, in componentSources only, a
 * `builtInName === "x"` check (commands handled inside a component rather
 * than in app.tsx). Component sources get only that strict form so unrelated
 * switch cases there (e.g. a processing stage) do not count.
 */
export function findUndispatched(
	names: string[],
	sources: string[],
	componentSources: string[] = [],
): string[] {
	const text = sources.join("\n");
	const componentText = componentSources.join("\n");
	return names.filter((n) => {
		const q = `["']${n}["']`;
		const forms = [
			new RegExp(`case\\s+${q}`),
			new RegExp(`command(?:\\s+as\\s+\\w+)?\\)?\\s*===\\s*\\(?${q}`),
		];
		const componentForm = new RegExp(`builtInName\\s*===\\s*${q}`);
		return !forms.some((re) => re.test(text)) && !componentForm.test(componentText);
	});
}
