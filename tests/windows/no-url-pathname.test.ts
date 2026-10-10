import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * On Windows, `new URL(..., import.meta.url).pathname` is "/D:/a/..." and
 * Bun.build, fs and spawn all reject it (CI run for PR #3783 failed on
 * scripts/build-bundles.ts). Use fileURLToPath instead.
 */
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const SCAN = ["bin", "scripts", "packages", "apps/tui/src"];
const PATTERN = /import\.meta\.url\)\.pathname/;
// Allowed: macOS-only Swift bridge, and a call guarded by __filename in Bun.
const ALLOW = new Set([
	"packages/eyes/utils/ax-bridge.ts",
	"packages/permissions/policy-engine.ts",
]);

function walk(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === ".build") continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name) && !full.includes("__tests__")) {
			out.push(full);
		}
	}
}

describe("windows path safety", () => {
	test("no source file builds a filesystem path from URL.pathname", () => {
		const files: string[] = [];
		for (const d of SCAN) walk(join(ROOT, d), files);
		const offenders = files
			.filter((f) => PATTERN.test(readFileSync(f, "utf-8")))
			.map((f) => relative(ROOT, f).split("\\").join("/"))
			.filter((f) => !ALLOW.has(f));
		expect(offenders).toEqual([]);
	});
});
