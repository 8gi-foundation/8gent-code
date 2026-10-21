import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBuildPaths, pathDefines, unresolveJsdomWorker, virtualRoot } from "./compiled-paths";

const enc = (s: string) => new TextEncoder().encode(s);
const ROOT = "/Users/builder/8gent-code";

describe("findBuildPaths (#4671)", () => {
	test("finds a build root baked into a binary", () => {
		const bin = enc(`\0\0var __dirname = "${ROOT}/packages/daemon/tools";\0`);
		expect(findBuildPaths(bin, [ROOT])).toEqual([ROOT]);
	});

	test("finds the release runner's checkout even when the local root differs", () => {
		const bin = enc(`x("/Users/runner/work/8gent-code/8gent-code/apps/tui/src/index.tsx")`);
		expect(findBuildPaths(bin, [ROOT])).toEqual(["/Users/runner/work/8gent-code"]);
		expect(findBuildPaths(enc('"/home/runner/work/8gent-code/x"'), [])).toEqual([
			"/home/runner/work/8gent-code",
		]);
	});

	test("finds a Windows root written with backslashes", () => {
		const bin = enc(String.raw`"C:\a\8gent-code\node_modules\x.js"`);
		expect(findBuildPaths(bin, ["C:/a/8gent-code"])).toEqual(["C:/a/8gent-code"]);
	});

	test("a root only counts at a path boundary", () => {
		expect(findBuildPaths(enc(`"${ROOT}-other/x" "${ROOT}s"`), [ROOT])).toEqual([]);
		expect(findBuildPaths(enc(`"${ROOT}-other" "${ROOT}/x"`), [ROOT])).toEqual([ROOT]);
	});

	test("third-party CI paths from prebuilt native addons are not our build", () => {
		const bin = enc(
			"/Users/runner/.cargo/registry/src/tokio/src/lib.rs /Users/runner/work/canvas/x",
		);
		expect(findBuildPaths(bin, [ROOT])).toEqual([]);
	});
});

describe("pathDefines", () => {
	test("point __dirname and __filename into the virtual filesystem", () => {
		expect(virtualRoot("linux")).toBe("/$bunfs/root");
		expect(virtualRoot("windows")).toBe("B:/~BUN/root");
		expect(pathDefines("darwin")).toEqual({
			__dirname: '"/$bunfs/root"',
			__filename: '"/$bunfs/root/8gent"',
		});
	});

	test("a bundle built with them carries no source path", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "compiled-paths-")));
		mkdirSync(join(dir, "node_modules", "cjs"), { recursive: true });
		writeFileSync(
			join(dir, "node_modules", "cjs", "index.js"),
			"module.exports = __dirname + __filename;",
		);
		writeFileSync(join(dir, "entry.ts"), 'import x from "cjs";\nconsole.log(x);\n');
		const out = await Bun.build({
			entrypoints: [join(dir, "entry.ts")],
			target: "bun",
			define: pathDefines("linux"),
		});
		const text = await out.outputs[0].text();
		rmSync(dir, { recursive: true, force: true });
		// Bun's "// <relative path>" comments are not strings; no quoted source path may remain.
		expect(text).not.toContain(`"${dir}`);
		expect(text).toContain("/$bunfs/root");
	});
});

describe("unresolveJsdomWorker", () => {
	test("keeps the worker name instead of its absolute build path", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "compiled-paths-jsdom-")));
		const xhr = join(dir, "node_modules", "jsdom", "lib", "jsdom", "living", "xhr");
		mkdirSync(xhr, { recursive: true });
		writeFileSync(join(xhr, "xhr-sync-worker.js"), "");
		writeFileSync(
			join(xhr, "XMLHttpRequest-impl.js"),
			'const syncWorkerFile = require.resolve("./xhr-sync-worker.js");\nmodule.exports = syncWorkerFile;\n',
		);
		writeFileSync(
			join(dir, "entry.ts"),
			`import w from ${JSON.stringify(join(xhr, "XMLHttpRequest-impl.js"))};\nconsole.log(w);\n`,
		);
		const out = await Bun.build({
			entrypoints: [join(dir, "entry.ts")],
			target: "bun",
			plugins: [unresolveJsdomWorker],
			define: pathDefines("linux"),
		});
		const text = await out.outputs[0].text();
		rmSync(dir, { recursive: true, force: true });
		expect(text).not.toContain(`"${dir}`);
		expect(text).toContain('"./xhr-sync-worker.js"');
	});
});
