/**
 * Finding: the product resolved the home directory ad hoc at ~180 call sites.
 * Sites calling os.homedir() cannot be sandboxed on Windows (bun's
 * os.homedir() reads USERPROFILE and ignores HOME), and the env-chain sites
 * degrade to "undefined/...", a literal "~" directory, or a cwd-relative path
 * when HOME is unset - all observed writing to disk.
 *
 * Fix: PR 2972 (commit e46ad475, packages/core/home.ts resolveHome(), the one
 * resolver, with EIGHT_HOME as the unambiguous switch) and PR 2981 (commit
 * 78189592, routes packages/computer/bridge.ts and the debugger system-health
 * route through it).
 * credit: Artale (8SO)
 *
 * State on main when this suite was written: the migration of the remaining
 * call sites (#2971 step 2) has NOT happened. 153 runtime files still call
 * homedir() directly. So this is a ratchet, not a "zero" assertion:
 *
 *   1. The sites Artale migrated must never go back to homedir().
 *   2. No runtime file outside the baseline may call homedir() directly.
 *   3. No baseline file may gain calls. Migrating a file means deleting its
 *      baseline entry; a stale entry fails, so the baseline only shrinks.
 *
 * The baseline (fixtures/homedir-baseline.ts) is NOT a list of legitimate
 * uses. Every entry is un-migrated backlog. The one legitimate direct call is
 * packages/core/home.ts itself, the resolver's final fallback, which is
 * excluded by name below.
 *
 * To print the current map (for shrinking the baseline):
 *   EIGHT_SEC_PRINT_HOMEDIR=1 bun test tests/security/home-resolver.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveHome } from "../../packages/core/home";
import { HOMEDIR_BASELINE } from "./fixtures/homedir-baseline";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const RUNTIME_ROOTS = ["apps", "packages", "bin", "scripts"];
// The resolver itself: its os.homedir() is the documented last fallback.
const LEGITIMATE = new Set(["packages/core/home.ts"]);
const MIGRATED_BY_ARTALE = ["packages/computer/bridge.ts", "apps/debugger/app/api/system-health/route.ts"];

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function countHomedirCalls(src: string): number {
	return (stripComments(src).match(/\bhomedir\s*\(/g) ?? []).length;
}

function isRuntimeFile(rel: string): boolean {
	if (!/\.(ts|tsx|js|mjs|cjs)$/.test(rel) || rel.endsWith(".d.ts")) return false;
	return !/(\.test\.|\.spec\.|(^|\/)tests?\/|__tests__|(^|\/)node_modules\/|(^|\/)dist\/|(^|\/)\.next\/)/.test(rel);
}

function walk(dir: string, out: string[]): void {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".next") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(relative(REPO_ROOT, p));
	}
}

function currentMap(): Record<string, number> {
	const files: string[] = [];
	for (const r of RUNTIME_ROOTS) walk(join(REPO_ROOT, r), files);
	const map: Record<string, number> = {};
	for (const f of files.filter(isRuntimeFile).sort()) {
		if (LEGITIMATE.has(f)) continue;
		const n = countHomedirCalls(readFileSync(join(REPO_ROOT, f), "utf-8"));
		if (n > 0) map[f] = n;
	}
	return map;
}

describe("home resolver (PR 2972 / PR 2981)", () => {
	const map = currentMap();
	if (process.env.EIGHT_SEC_PRINT_HOMEDIR === "1") console.log(JSON.stringify(map, null, "\t"));

	test("the sites Artale migrated do not call homedir() and do use resolveHome()", () => {
		for (const f of MIGRATED_BY_ARTALE) {
			const src = readFileSync(join(REPO_ROOT, f), "utf-8");
			expect({ file: f, calls: countHomedirCalls(src) }).toEqual({ file: f, calls: 0 });
			expect(src).toMatch(/\bresolveHome\s*\(/);
		}
	});

	test("no runtime file outside the baseline calls homedir() directly", () => {
		const unexpected = Object.keys(map).filter((f) => !(f in HOMEDIR_BASELINE));
		expect(unexpected).toEqual([]);
	});

	test("no baseline file gained homedir() calls", () => {
		const grew = Object.entries(map)
			.filter(([f, n]) => f in HOMEDIR_BASELINE && n > HOMEDIR_BASELINE[f])
			.map(([f, n]) => `${f}: ${HOMEDIR_BASELINE[f]} -> ${n}`);
		expect(grew).toEqual([]);
	});

	test("the baseline has no stale entries (it may only shrink, and must be edited when it does)", () => {
		const stale = Object.entries(HOMEDIR_BASELINE)
			.filter(([f, n]) => (map[f] ?? 0) < n)
			.map(([f, n]) => `${f}: baseline ${n}, now ${map[f] ?? 0}`);
		expect(stale).toEqual([]);
	});

	test("resolveHome honours EIGHT_HOME, which os.homedir() cannot", () => {
		expect(resolveHome({ EIGHT_HOME: "/sandbox/h", HOME: "/real" }, "linux")).toBe("/sandbox/h");
		expect(resolveHome({ EIGHT_HOME: "C:\\sandbox", USERPROFILE: "C:\\Users\\x" }, "win32")).toBe("C:\\sandbox");
		expect(resolveHome({ USERPROFILE: "C:\\Users\\x", HOME: "/c/Users/y" }, "win32")).toBe("C:\\Users\\x");
	});
});
