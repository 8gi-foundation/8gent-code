// #3892: sharp's native addon is not embedded by `bun build --compile`, so a
// top-level import of it crashed the standalone Windows exe on `run` before
// any model call ("Could not load the sharp module using the win32-x64
// runtime"). No product module may import sharp statically; the image paths
// load it with `await import("sharp")` where they need it.
//
// A runtime plugin cannot observe a CJS package load in Bun, so this is a
// source check; the windows-task CI job is the behavioural proof on the exe.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const SCAN = ["packages", "bin", "apps"];

function* sources(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) yield* sources(p);
		else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) yield p;
	}
}

// import sharp from "sharp" / import * as sharp / import { x } / require("sharp") at module level.
// `import type` is erased and allowed.
// The binding clause may span lines (`import {\n x,\n} from "sharp"`), so braces are matched with [^}]*.
const STATIC = /^\s*(?:import\s+(?!type\b)(?:[\w$]+\s*,?\s*)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+)?\s*from\s*|import\s+|(?:const|let|var)\s+\w+\s*=\s*require\()\s*["']sharp["']/m;

describe("sharp is lazy", () => {
	test("no product module imports sharp statically", () => {
		const offenders: string[] = [];
		for (const top of SCAN) {
			for (const file of sources(join(root, top))) {
				if (STATIC.test(readFileSync(file, "utf8"))) offenders.push(relative(root, file));
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the guard sees an eager import (it is not vacuous)", () => {
		expect(STATIC.test('import sharp from "sharp";\n')).toBe(true);
		expect(STATIC.test('import type SharpFn from "sharp";\n')).toBe(false);
		expect(STATIC.test('import {\n\tdefault as sharp,\n} from "sharp";\n')).toBe(true);
		expect(STATIC.test('import sharp, {\n\tx\n} from "sharp"\n')).toBe(true);
		expect(STATIC.test('import type {\n\tSharp,\n} from "sharp";\n')).toBe(false);
		expect(STATIC.test('const m = (await import("sharp")).default;\n')).toBe(false);
	});
});
