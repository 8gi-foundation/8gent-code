/**
 * Termux / Android guard (see the Termux issue): `npm i -g @8gi-foundation/8gent-code` must install with no flags
 * on platforms that native toolchains do not support. A single required dependency with an
 * install script (workerd via miniflare did this on android arm64) breaks the whole install.
 *
 * Walks the production dependency graph the way `npm i -g` sees it: root `dependencies` and
 * each package's own `dependencies`, resolved through node_modules. Optional dependencies
 * (and everything only they pull in) are skipped, because npm tolerates their failure.
 * Needs `bun install` first, like the other tests.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Pkg = {
	name?: string;
	dependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	gypfile?: boolean;
};

const readPkg = (dir: string): Pkg => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** Node resolution: nearest node_modules/<name> walking up from `from`. */
function resolveDir(name: string, from: string, modules: string): string | null {
	let dir = from;
	for (;;) {
		const cand = join(dir, modules, name);
		if (existsSync(join(cand, "package.json"))) return cand;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;

function installScriptOffenders(
	rootDir: string,
	modules = "node_modules",
): { missing: string[]; offenders: string[] } {
	const missing: string[] = [];
	const offenders: string[] = [];
	const seen = new Set<string>();
	const walk = (name: string, from: string, via: string) => {
		const dir = resolveDir(name, from, modules);
		if (!dir) {
			missing.push(`${via} > ${name}`);
			return;
		}
		if (seen.has(dir)) return;
		seen.add(dir);
		const pkg = readPkg(dir);
		const hooks = INSTALL_HOOKS.filter((h) => pkg.scripts?.[h]);
		// npm runs `node-gyp rebuild` for a package with binding.gyp and no install script.
		if (hooks.length === 0 && existsSync(join(dir, "binding.gyp"))) hooks.push("install" as never);
		if (hooks.length > 0) offenders.push(`${via} > ${name} (${hooks.join(", ")})`);
		for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir, `${via} > ${name}`);
	};
	const rootPkg = readPkg(rootDir);
	for (const dep of Object.keys(rootPkg.dependencies ?? {})) walk(dep, rootDir, "root");
	return { missing, offenders };
}

test("no required runtime dependency has an install script", () => {
	const { missing, offenders } = installScriptOffenders(root);
	expect(missing).toEqual([]);
	expect(offenders).toEqual([]);
});

test("the walker flags an install script and skips optional dependencies", () => {
	const fx = join(root, "packages", "node-compat", "fixtures", "install-scripts");
	const { offenders } = installScriptOffenders(fx, "pkgs");
	expect(offenders).toEqual([
		"root > bad-direct (postinstall)",
		"root > ok-parent > bad-transitive (install)",
	]);
});

/**
 * A package the bundles reach by FILE PATH (not by import) is not inlined, so a production
 * install must still contain it. jsdom's sync-XHR worker and ink's instances.js were found
 * this way after they were moved to devDependencies. Needs `bun run build`; skips otherwise.
 */
const bundles = ["cli.js", "tui.js", "node/cli.js", "node/tui.js"]
	.map((f) => join(root, "dist", f))
	.filter((f) => existsSync(f));

function pathLookupTargets(src: string): Set<string> {
	const out = new Set<string>();
	const re = /\.resolve\(\s*\(?[^)\n]*?node_modules\/((?:@[^/"']+\/)?[^/"']+)\//g;
	for (const m of src.matchAll(re)) out.add(m[1]);
	return out;
}

test.skipIf(bundles.length === 0)(
	"bundle path lookups into node_modules are runtime dependencies",
	() => {
		const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg & {
			optionalDependencies?: Record<string, string>;
		};
		const runtime = new Set([
			...Object.keys(rootPkg.dependencies ?? {}),
			...Object.keys(rootPkg.optionalDependencies ?? {}),
		]);
		const missing: string[] = [];
		for (const b of bundles)
			for (const t of pathLookupTargets(readFileSync(b, "utf8")))
				if (!runtime.has(t)) missing.push(`${b.replace(`${root}/`, "")} resolves ${t} by path`);
		expect(missing).toEqual([]);
		// the lookup is really detected (jsdom's worker), so an empty result is not a blind regex
		expect(pathLookupTargets(readFileSync(bundles[0], "utf8")).has("jsdom")).toBe(true);
	},
);

test("source-level resolve of a package file names a runtime dependency", () => {
	const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg;
	const deps = rootPkg.dependencies ?? {};
	for (const [file, pkg] of [
		["packages/daemon/live-anatomy.ts", "mermaid"],
		["apps/tui/src/lib/mouse-wiring.ts", "ink"],
	] as const) {
		expect(readFileSync(join(root, file), "utf8")).toContain(pkg);
		expect(deps[pkg]).toBeDefined();
	}
});
