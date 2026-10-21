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
