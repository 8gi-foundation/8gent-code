import { describe, expect, test } from "bun:test";
import { findBakedRoots, unbakeBuildPaths } from "./unbake-build-paths.js";

const ROOT = "/Users/builder/8gent-code";
const REAL_NM_ROOT = "/Users/builder/src/8gent-code";

describe("unbakeBuildPaths (#3219)", () => {
	test("rewrites __dirname literals to paths relative to the bundle", () => {
		const src = `var __dirname = "${ROOT}/packages/daemon/tools", REPO_ROOT;`;
		const { code, replaced } = unbakeBuildPaths(src, [ROOT]);
		expect(replaced).toBe(1);
		expect(code).toBe(
			`var __dirname = (import.meta.dir + "/../packages/daemon/tools"), REPO_ROOT;`,
		);
	});

	test("handles node_modules resolved through a symlink to another checkout", () => {
		const src = `__require.resolve("${REAL_NM_ROOT}/node_modules/jsdom/lib/xhr-sync-worker.js");`;
		const { code } = unbakeBuildPaths(src, [ROOT, REAL_NM_ROOT]);
		expect(code).toBe(
			`__require.resolve((import.meta.dir + "/../node_modules/jsdom/lib/xhr-sync-worker.js"));`,
		);
	});

	test("rewrites the bare root and leaves unrelated strings alone", () => {
		const src = `a = "${ROOT}"; b = "${ROOT}-other/x"; c = "/Users/";`;
		const { code, replaced } = unbakeBuildPaths(src, [ROOT]);
		expect(replaced).toBe(1);
		expect(code).toBe(`a = (import.meta.dir + "/.."); b = "${ROOT}-other/x"; c = "/Users/";`);
	});

	test("prefers the longer root when one root contains another", () => {
		const nested = `${ROOT}/wt/branch`;
		const src = `x = "${nested}/apps/tui/src";`;
		const { code } = unbakeBuildPaths(src, [ROOT, nested]);
		expect(code).toBe(`x = (import.meta.dir + "/../apps/tui/src");`);
	});

	test("normalises escaped Windows backslashes", () => {
		const root = "C:\\a\\8gent-code";
		const src = `x = ${JSON.stringify(`${root}\\packages\\registry`)};`;
		const { code, replaced } = unbakeBuildPaths(src, [root]);
		expect(replaced).toBe(1);
		expect(code).toBe(`x = (import.meta.dir + "/../packages/registry");`);
	});

	test("the rewritten expression evaluates relative to the bundle", () => {
		const { code } = unbakeBuildPaths(`"${ROOT}/packages/registry"`, [ROOT]);
		const fn = new Function("dir", `return ${code.replace("import.meta.dir", "dir")};`);
		expect(fn("/opt/lib/node_modules/@8gi-foundation/8gent-code/dist")).toBe(
			"/opt/lib/node_modules/@8gi-foundation/8gent-code/dist/../packages/registry",
		);
	});
});

describe("findBakedRoots", () => {
	test("reports roots anywhere, and home only at the start of a literal", () => {
		expect(findBakedRoots(`"file://${ROOT}/x"`, [ROOT])).toEqual([ROOT]);
		expect(findBakedRoots(`"/root/.cache"`, [], ["/root"])).toEqual(["/root"]);
		expect(findBakedRoots(`"/rootfs/etc"`, [], ["/root"])).toEqual([]);
		expect(findBakedRoots(`"anything"`, [], ["/"])).toEqual([]);
		expect(findBakedRoots(`clean`, [ROOT], ["/Users/builder"])).toEqual([]);
	});
});
