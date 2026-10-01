/**
 * Locate 8gent's own scripts (bin/debug.ts, bin/lil-eight.sh) from the
 * package's location, never from the working folder (#3264).
 *
 * The TUI runs in the folder the user launched it from. A lookup like
 * `join(process.cwd(), "bin", "debug.ts")` would then execute whatever a
 * cloned repo keeps at that path, so these scripts resolve from this module.
 *
 * `__dirname` is used on purpose: in a source checkout it is apps/tui/src/lib,
 * and Bun's bundler rewrites it in dist/tui.js to
 * `import.meta.dir + "/../apps/tui/src/lib"`, so the same relative hop reaches
 * the package root in both layouts. `import.meta.dirname` is not rewritten and
 * would point at dist/ in the bundle.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Root of the 8gent-code checkout or installed package. */
export const PACKAGE_ROOT = resolve(__dirname, "../../../..");

/**
 * Absolute path of a script under the package's bin/ folder, or null when the
 * package does not ship it (the npm package ships only bin/8gent-run.js).
 */
export function packageBinScript(name: string, root: string = PACKAGE_ROOT): string | null {
	const candidate = join(root, "bin", name);
	return existsSync(candidate) ? candidate : null;
}
