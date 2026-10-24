import { expect, test } from "bun:test";
import {
	INK_PATCH_MARKERS,
	bundledPackageDirs,
	checkBundle,
	checkInkPatch,
} from "./check-bundle-versions";

test("bundledPackageDirs finds hoisted, nested and scoped package folders", () => {
	const src = [
		"// node_modules/chalk/source/index.js",
		"// node_modules/chalk/node_modules/ansi-styles/index.js",
		"// node_modules/@alcalzone/ansi-tokenize/build/reduce.js",
		"// apps/tui/src/app.tsx",
	].join("\n");
	expect([...bundledPackageDirs(src)].sort()).toEqual([
		"node_modules/@alcalzone/ansi-tokenize",
		"node_modules/chalk",
		"node_modules/chalk/node_modules/ansi-styles",
	]);
});

test("checkBundle reports nothing for a bundle with no npm packages", () => {
	expect(checkBundle("// apps/tui/src/app.tsx\n")).toEqual([]);
});

// #4970: the TUI's incremental writer needs patches/ink@6.8.0.patch in the bundle.
const PATCHED = [
	"// node_modules/ink/build/log-update.js",
	"            buffer.push(ansiEscapes.cursorUp(previousLines.length - 1));",
	"            if (i < previousVisible && nextLines[i] === previousLines[i]) {",
].join("\n");
const UNPATCHED = [
	"// node_modules/ink/build/log-update.js",
	"            buffer.push(ansiEscapes.cursorUp(previousVisible - 1));",
	"            if (nextLines[i] === previousLines[i]) {",
].join("\n");

test("checkInkPatch passes a TUI bundle that carries the Ink patch", () => {
	expect(checkInkPatch("/repo/dist/tui.js", PATCHED)).toEqual([]);
	expect(checkInkPatch("/repo/dist/node/tui.js", PATCHED)).toEqual([]);
});

test("checkInkPatch fails a TUI bundle built from unpatched Ink", () => {
	for (const file of ["/repo/dist/tui.js", "/repo/dist/node/tui.js"]) {
		const problems = checkInkPatch(file, UNPATCHED);
		expect(problems).toHaveLength(INK_PATCH_MARKERS.length);
		expect(problems[0]).toContain("cursorUp(previousLines.length - 1)");
	}
});

test("checkInkPatch ignores bundles that are not the TUI", () => {
	expect(checkInkPatch("/repo/dist/cli.js", UNPATCHED)).toEqual([]);
	expect(checkInkPatch("/repo/dist/node/pty-bridge.js", "")).toEqual([]);
});

// The production call shape: the script's own entry point, on a real file.
test("the script exits 1 on an unpatched tui.js and 0 on a patched one", async () => {
	const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "ink-patch-check-"));
	try {
		const run = (body: string) => {
			const sub = join(dir, body === PATCHED ? "ok" : "bad");
			mkdirSync(sub, { recursive: true });
			const file = join(sub, "tui.js");
			writeFileSync(file, body);
			return Bun.spawnSync([
				process.execPath,
				join(import.meta.dir, "check-bundle-versions.ts"),
				file,
			]);
		};
		const bad = run(UNPATCHED);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr.toString()).toContain("Ink's incremental writer is unpatched");
		expect(run(PATCHED).exitCode).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
