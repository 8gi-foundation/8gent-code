/**
 * arch-rules: forbidden edges and the no-new-cycles ratchet, over real files in a
 * temp packages/ tree (real dep-graph, no mocks), plus the real repo against its own rules.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ArchRules, checkRules, cycleGroups, packageEdges } from "./arch-rules";

const REPO = path.resolve(import.meta.dir, "../..");
let tmp = "";

/** files: { "a/index.ts": "import ..." } under <tmp>/packages */
function fixture(files: Record<string, string>): string {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arch-rules-"));
	for (const [rel, body] of Object.entries(files)) {
		const f = path.join(tmp, "packages", rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, body);
	}
	return path.join(tmp, "packages");
}

afterEach(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = "";
});

const BASE = {
	"a/index.ts": 'import { b } from "../b/index";\nexport const a = 1;',
	"b/index.ts": 'import { a } from "@8gent/a";\nexport const b = 2;',
	"c/index.ts": 'import { b } from "../b/index.js";\nexport const c = 3;',
	"perm/index.ts": "export const p = 0;",
};
const RULES: ArchRules = {
	forbidden: [{ from: "perm", to: "a", reason: "test" }],
	baselineCycleGroups: [["a", "b"]],
};

describe("arch-rules", () => {
	test("baseline passes: the recorded a<->b cycle is allowed", () => {
		const edges = packageEdges(fixture(BASE));
		expect(cycleGroups(edges)).toEqual([["a", "b"]]);
		expect(checkRules(edges, RULES)).toEqual([]);
	});

	test("a forbidden edge fails and names the file", () => {
		const edges = packageEdges(
			fixture({ ...BASE, "perm/index.ts": 'export * from "../a/index";' }),
		);
		const v = checkRules(edges, RULES);
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("forbidden: perm must not import a");
		expect(v[0]).toContain("perm/index.ts -> a/index.ts");
	});

	test("a new cycle fails, including one that grows a baseline group", () => {
		const edges = packageEdges(fixture({ ...BASE, "b/extra.ts": 'import { c } from "../c";' }));
		const v = checkRules(edges, RULES);
		expect(v).toEqual(["new cycle: c now in a cycle with a, b, c"]);
	});

	test("a cycle between two new packages fails", () => {
		const edges = packageEdges(
			fixture({ ...BASE, "d/index.ts": 'import "../e";', "e/index.ts": 'import "../d";' }),
		);
		expect(checkRules(edges, RULES)).toEqual(["new cycle: d, e now in a cycle with d, e"]);
	});

	test("test files do not create package edges", () => {
		const edges = packageEdges(fixture({ ...BASE, "perm/x.test.ts": 'import { a } from "../a";' }));
		expect(checkRules(edges, RULES)).toEqual([]);
	});

	test("a forbidden rule naming a package that does not exist fails", () => {
		const edges = packageEdges(fixture(BASE));
		const v = checkRules(edges, { ...RULES, forbidden: [{ from: "prem", to: "a" }] });
		expect(v).toEqual([
			"unknown package in forbidden rule: prem (typo, or the package was removed)",
		]);
	});

	// Advisory until a separate CI-step PR with 8SO review: `bun run test` runs in CI,
	// so this gate only runs when EIGHT_ARCH_GATE=1 is set exactly.
	test.skipIf(process.env.EIGHT_ARCH_GATE !== "1")(
		"the real repo passes against architecture.rules.json (EIGHT_ARCH_GATE=1 only; advisory until wired into CI)",
		() => {
			const r = spawnSync(process.execPath, ["packages/ast-index/arch-rules.ts"], {
				cwd: REPO,
				encoding: "utf-8",
			});
			expect(r.stderr).toBe("");
			expect(r.stdout).toContain("arch-rules: OK");
			expect(r.status).toBe(0);
		},
	);
});
