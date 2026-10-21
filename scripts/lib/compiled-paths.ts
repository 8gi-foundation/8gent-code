/**
 * Keep build-machine paths out of the compiled 8gent binaries (#4671).
 *
 * `bun build --compile` writes the absolute source path of every bundled
 * `__dirname` / `__filename` (our ESM files and CommonJS dependencies such as
 * typescript, jsdom and convex) and of every `require.resolve("./x")` into the
 * binary. On a user's machine that path does not exist; on the builder's own Mac
 * it resolves into the checkout, so the bug hides exactly where it was made.
 * Inside a compiled binary every bundled module lives in Bun's virtual
 * filesystem, so the virtual root is the honest value for both.
 */
import type { BunPlugin } from "bun";

/** The directory `import.meta.dir` reports inside a compiled binary for that OS. */
export function virtualRoot(os: "darwin" | "linux" | "windows"): string {
	return os === "windows" ? "B:/~BUN/root" : "/$bunfs/root";
}

/** Bun.build `define` entries that replace baked `__dirname` / `__filename`. */
export function pathDefines(os: "darwin" | "linux" | "windows"): Record<string, string> {
	const root = virtualRoot(os);
	return {
		__dirname: JSON.stringify(root),
		__filename: JSON.stringify(`${root}/8gent`),
	};
}

/**
 * jsdom resolves its sync-XHR worker with require.resolve at bundle time, which
 * bakes the absolute node_modules path. The worker cannot run from a compiled
 * binary anyway (it is spawned as a separate Node script), so keep the name only.
 */
export const unresolveJsdomWorker: BunPlugin = {
	name: "unresolve-jsdom-sync-worker",
	setup(build) {
		build.onLoad(
			{ filter: /[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ },
			async (args) => {
				const text = await Bun.file(args.path).text();
				return {
					contents: text.replace(
						/require\.resolve\(\s*["']\.\/xhr-sync-worker\.js["']\s*\)/g,
						'"./xhr-sync-worker.js"',
					),
					loader: "js",
				};
			},
		);
	},
};

/** Path prefixes of the 8gent checkout on the release runners, whatever the local roots are. */
export const CI_BUILD_ROOTS = ["/Users/runner/work/8gent-code", "/home/runner/work/8gent-code"];

/**
 * Every build root that appears in `bytes`, ending at a path boundary. Roots,
 * not the builder's home: third-party prebuilt native addons carry their own CI
 * paths (a Rust panic location under /Users/runner/.cargo, say) that are not our
 * build and never resolve to code, and on a hosted runner home is /Users/runner.
 */
export function findBuildPaths(bytes: Uint8Array, roots: string[]): string[] {
	const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
	const found = new Set<string>();
	for (const root of new Set([...roots, ...CI_BUILD_ROOTS])) {
		if (!root || root.length < 2) continue;
		const variants = new Set([root, root.replace(/\//g, "\\"), JSON.stringify(root).slice(1, -1)]);
		for (const v of variants) {
			// "/work" must not match "/workspace": a root ends at anything but a name character.
			let at = text.indexOf(v);
			while (at !== -1) {
				const next = text.charAt(at + v.length);
				if (!/[A-Za-z0-9_.-]/.test(next)) {
					found.add(root);
					break;
				}
				at = text.indexOf(v, at + 1);
			}
		}
	}
	return [...found];
}
