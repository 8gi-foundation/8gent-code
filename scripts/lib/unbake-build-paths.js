// Remove build-machine absolute paths from a Bun bundle (#3219).
//
// `bun build` replaces every `__dirname` / `__filename` it bundles (our own
// ESM files and CommonJS dependencies such as typescript, jsdom and convex)
// with the absolute path of the source file ON THE BUILD MACHINE, e.g.
//
//   var __dirname = "/Users/<builder>/8gent-code/packages/daemon/tools";
//
// Shipped to npm, that path does not exist anywhere else, and on the builder's
// own Mac it silently resolves into the source checkout, so the bug hides
// exactly where it was made. Bun has no flag to keep these as runtime values.
//
// This rewrites each string literal that starts with a build root into an
// expression relative to the bundle file itself:
//
//   "<root>/packages/daemon/tools"  ->  (import.meta.dir + "/../packages/daemon/tools")
//
// The bundle lives at <root>/dist/*.js, so `import.meta.dir + "/.."` is the
// package root at runtime, wherever it was installed. Paths that do not exist
// in the published package (source folders) stay non-existent, exactly as they
// already were on every machine except the builder's; callers already handle
// that. `import.meta.dir` is kept as a runtime value by `bun build`.

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} source  bundle text
 * @param {string[]} roots absolute build roots to strip (checkout root, and the
 *                         real directory node_modules resolves into, if different)
 * @returns {{ code: string, replaced: number }}
 */
export function unbakeBuildPaths(source, roots) {
	let code = source;
	let replaced = 0;
	// Longest root first so a nested root is never half-matched by its parent.
	const unique = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length);
	for (const root of unique) {
		// The root as it appears inside a JS string literal (backslashes on Windows are escaped).
		const inLiteral = JSON.stringify(root).slice(1, -1);
		const re = new RegExp(`"${escapeRegExp(inLiteral)}((?:\\\\\\\\|/)[^"\\n]*)?"`, "g");
		code = code.replace(re, (_m, rest = "") => {
			replaced++;
			const tail = rest.replace(/\\\\/g, "/");
			return `(import.meta.dir + ${JSON.stringify(`/..${tail}`)})`;
		});
	}
	return { code, replaced };
}

/**
 * Return the build-machine paths still present in the bundle text.
 * Build roots are specific, so any occurrence counts. A home directory is
 * shorter and more generic (`/root` in a container), so it only counts as the
 * start of a string literal, e.g. `"/Users/alice/...`.
 */
export function findBakedRoots(source, roots, homes = []) {
	const lit = (p) => JSON.stringify(p).slice(1, -1);
	// A root only counts when it ends at a path boundary. A short root such as the
	// CI container's `/work` otherwise matches `/workspace` or `/workers` inside
	// bundled dependencies, and fails a build that is actually clean.
	const found = [...new Set(roots.filter(Boolean))].filter((r) =>
		new RegExp(`${escapeRegExp(lit(r))}(?![A-Za-z0-9_.-])`).test(source),
	);
	for (const home of new Set(homes)) {
		if (!home || home.length < 2) continue;
		if (source.includes(`"${lit(home)}/`) || source.includes(`"${lit(home)}\\`)) found.push(home);
	}
	return found;
}
