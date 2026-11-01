#!/usr/bin/env bun
/**
 * Post-build scan: every npm package bundled into dist/tui.js, dist/cli.js and dist/node/*.js must
 * have been bundled against a version its dependents accept.
 *
 * Why: a bundler follows whatever node_modules it finds. A damaged or non-frozen install can leave
 * a package without its nested copy of a dependency, and the bundler then silently uses a different
 * major (chalk 4 against ansi-styles 6, Termux v0.20.8: "Cannot read properties of undefined
 * (reading 'ansi16m')"). Nothing fails until a user hits that path.
 *
 * How: the bundle marks each module with "// node_modules/<...>/<pkg>/<file>". From those markers
 * we get the package folders in the bundle. For each, we read its package.json `dependencies` and
 * resolve every bundled dependency the way Node would (walking up node_modules from that folder).
 * That resolved version must satisfy the declared range (a copy that is installed but never
 * imported is harmless, so presence in the bundle is not required).
 * It does not care which packages exist: it checks what the bundle contains against what each
 * bundled package declared.
 *
 * It also checks that every TUI bundle (any file named tui.js) carries the lines of
 * patches/ink@6.8.0.patch (#4970). The TUI renders with Ink's incremental writer, which is wrong
 * by one row without that patch. A bun patch keys on the exact Ink version, so an Ink bump drops
 * it silently; this check makes that build fail instead of shipping a broken screen.
 *
 *   bun scripts/check-bundle-versions.ts [bundle.js ...]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Pkg = { name?: string; version?: string; dependencies?: Record<string, string> };

function readPkg(dir: string): Pkg | null {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg;
	} catch {
		return null;
	}
}

/** Package folders (root-relative, e.g. "node_modules/chalk") that a bundle contains. */
export function bundledPackageDirs(source: string): Set<string> {
	const dirs = new Set<string>();
	for (const m of source.matchAll(
		/^\/\/ ((?:[^\s]*\/)?node_modules\/(?:@[^/\s]+\/)?[^/\s]+)\//gm,
	)) {
		const full = m[1];
		const at = full.lastIndexOf("node_modules/");
		const rest = full.slice(at + "node_modules/".length);
		dirs.add(`${full.slice(0, at)}node_modules/${rest}`);
	}
	return dirs;
}

/** Folder Node resolves `dep` to when required from inside `fromDir` (root-relative), or null. */
function resolveDep(fromDir: string, dep: string): string | null {
	let cur = fromDir;
	for (;;) {
		const cand = join(cur, "node_modules", dep);
		if (existsSync(join(root, cand, "package.json"))) return cand;
		const parent = dirname(cur);
		if (parent === cur || parent === ".") break;
		cur = parent;
	}
	const top = join("node_modules", dep);
	return existsSync(join(root, top, "package.json")) ? top : null;
}

const NOT_SEMVER = /^(workspace:|file:|link:|git|github:|https?:|npm:|catalog:|\*$|latest$|$)/;

export function checkBundle(source: string): string[] {
	const dirs = bundledPackageDirs(source);
	const byName = new Map<string, Set<string>>();
	for (const d of dirs) {
		const name = d.slice(d.lastIndexOf("node_modules/") + "node_modules/".length);
		if (!byName.has(name)) byName.set(name, new Set());
		byName.get(name)?.add(d);
	}
	const problems: string[] = [];
	for (const dir of [...dirs].sort()) {
		const pkg = readPkg(join(root, dir));
		if (!pkg?.dependencies) continue;
		for (const [dep, range] of Object.entries(pkg.dependencies)) {
			if (!byName.has(dep) || NOT_SEMVER.test(range)) continue;
			const resolved = resolveDep(dir, dep);
			const at = `${dir} needs ${dep}@${range}`;
			if (!resolved) {
				problems.push(`${at}, but it resolves to nothing while ${dep} is bundled from elsewhere`);
				continue;
			}
			const version = readPkg(join(root, resolved))?.version ?? "?";
			if (!Bun.semver.satisfies(version, range)) {
				problems.push(`${at}, but ${resolved} is ${version}`);
			}
		}
	}
	return problems;
}

/** Lines from patches/ink@6.8.0.patch that every TUI bundle must contain (#4970). */
export const INK_PATCH_MARKERS = [
	"cursorUp(previousLines.length - 1)",
	"i < previousVisible && nextLines[i] === previousLines[i]",
];

/** Missing Ink patch lines in a bundle; only TUI bundles (named tui.js) are checked. */
export function checkInkPatch(file: string, source: string): string[] {
	if (!/(^|[\\/])tui\.js$/.test(file)) return [];
	return INK_PATCH_MARKERS.filter((m) => !source.includes(m)).map(
		(m) =>
			`Ink's incremental writer is unpatched: "${m}" is missing. patches/ink@6.8.0.patch did not apply (was Ink bumped?). Port the patch to the new version or drop incrementalRendering in apps/tui/src/lib/render-options.ts.`,
	);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const files = args.length
		? args.map((f) => resolve(f))
		: [
				join(root, "dist", "tui.js"),
				join(root, "dist", "cli.js"),
				...(existsSync(join(root, "dist", "node"))
					? readdirSync(join(root, "dist", "node"))
							.filter((f) => f.endsWith(".js"))
							.map((f) => join(root, "dist", "node", f))
					: []),
			].filter((f) => existsSync(f));
	if (files.length === 0) {
		console.error("[check-bundle-versions] no bundles found; run the build first");
		process.exit(1);
	}
	let bad = 0;
	for (const f of files) {
		const source = readFileSync(f, "utf8");
		const problems = [...checkBundle(source), ...checkInkPatch(f, source)];
		const rel = relative(root, f);
		if (problems.length === 0) console.log(`[check-bundle-versions] ${rel}: ok`);
		for (const p of problems) {
			bad++;
			console.error(`[check-bundle-versions] ${rel}: ${p}`);
		}
	}
	if (bad > 0) {
		console.error(
			`[check-bundle-versions] ${bad} problem(s). Run a clean "bun install --frozen-lockfile" and rebuild.`,
		);
		process.exit(1);
	}
}
