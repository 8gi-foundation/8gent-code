/**
 * The judge-set harvester and 8J fit. Fixtures use placeholder strings ("cmd-a"): the harvester
 * reads labels, not command meaning. The last block checks the committed calibration against
 * the committed results file it was fitted from.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCalibration, toRawGuardOptions } from "../../calibrate";
import { fitLines, lineVerdict, roundDown, roundUp, splitRows } from "./fit-8j";
import { type Row, harvestFile } from "./harvest";

const labels = (rows: Row[]) => rows.map((r) => [r.cmd, r.risky, r.how]);

describe("harvestFile", () => {
	test("tuple tables: block and escalate are risky, pass is skipped", () => {
		const src = `check([["cmd-a", "block", "r1"], ["cmd-b", "escalate"], ["cmd-c", "pass"]]);`;
		expect(labels(harvestFile(src, "x.test.ts", "x"))).toEqual([
			["cmd-a", true, "tuple"],
			["cmd-b", true, "tuple"],
		]);
	});

	test("expect(decideRules(cmd).verdict).toBe(V)", () => {
		const src = `expect(decideRules("cmd-a").verdict).toBe("escalate");
expect(decideRules("cmd-b", { cwd: "/" }).verdict).toBe("pass");`;
		expect(labels(harvestFile(src, "x.test.ts", "x"))).toEqual([["cmd-a", true, "rules"]]);
	});

	test("corpus: verdicts(ARR) equals all(ARR, V), ARR a const", () => {
		const src = `const corpus = ["cmd-a", "cmd-b"];
it("x", () => expect(verdicts(corpus)).toEqual(all(corpus, "block")));`;
		const rows = harvestFile(src, "x.test.ts", "x");
		expect(labels(rows)).toEqual([
			["cmd-a", true, "corpus"],
			["cmd-b", true, "corpus"],
		]);
		expect(rows[0].block).toBe(rows[1].block);
	});

	test("loop: asserted verdict, or run true for the safe list", () => {
		const src = `const ASKED = [["cmd-a", "rule"]];
const SAFE = ["cmd-b"];
for (const [command, rule] of ASKED) { test(command, async () => { expect(r.guard?.verdict).toBe("escalate"); }); }
for (const command of SAFE) { test(command, async () => { expect(r.run).toBe(true); }); }`;
		expect(labels(harvestFile(src, "x.test.ts", "x"))).toEqual([
			["cmd-a", true, "loop"],
			["cmd-b", false, "loop"],
		]);
	});

	test("rows: ALL(ran) is safe, any blocked or asked is risky", () => {
		const src = `const R = [{ id: "1", command: "cmd-a", expect: ALL("ran") },
{ id: "2", command: "cmd-b", expect: { default: "asked", guarded: "blocked" } }];`;
		expect(labels(harvestFile(src, "x.test.ts", "x"))).toEqual([
			["cmd-a", false, "rows"],
			["cmd-b", true, "rows"],
		]);
	});

	test("gate: run true in the same block is safe; stubs and budget overrides are skipped", () => {
		const src = `it("a", async () => { const r = await systemOneGate("cmd-a", on); expect(r.run).toBe(true); });
it("b", async () => { const r = await systemOneGate("echo SYS1_LOW", on); expect(r.run).toBe(true); });
it("c", async () => { const r = await systemOneGate("cmd-c", { ...on, [SYSTEM_ONE_TIMEOUT_ENV]: "1" }); expect(r.run).toBe(true); });`;
		expect(labels(harvestFile(src, "x.test.ts", "x"))).toEqual([["cmd-a", false, "gate"]]);
	});
});

const row = (cmd: string, risky: boolean, how: string, block: string): Row => ({
	cmd,
	risky,
	src: "s",
	how,
	block,
});

describe("splitRows", () => {
	test("a variant list lands whole in one split; spellings that normalise equal group", () => {
		const rows = Array.from({ length: 40 }, (_, i) => row(`cmd-${i} x`, true, "corpus", "B1"));
		rows.push(row("cmd 'q' 1", true, "loop", "L1"), row('cmd "q" 22', true, "loop", "L2"));
		const items = splitRows(rows);
		const list = items.filter((i) => i.cmd.endsWith(" x"));
		expect(new Set(list.map((i) => i.split)).size).toBe(1);
		const pair = items.filter((i) => i.cmd.includes("q"));
		expect(pair[0].group).toBe(pair[1].group);
		expect(pair[0].split).toBe(pair[1].split);
	});

	test("an unrelated list is not grouped by its array", () => {
		const rows = Array.from({ length: 40 }, (_, i) =>
			row(`word${String.fromCharCode(97 + (i % 26))}${"z".repeat(i)}`, false, "loop", "L"),
		);
		expect(new Set(splitRows(rows).map((i) => i.split)).size).toBe(2);
	});

	test("conflicting labels for one command throw", () => {
		expect(() =>
			splitRows([row("cmd-a", true, "loop", "a"), row("cmd-a", false, "loop", "b")]),
		).toThrow();
	});
});

describe("fitLines", () => {
	test("allow line from risky commands the rules pass only; block line over safe", () => {
		const lines = fitLines([
			{ risky: true, p: 0.01, rules: "block" },
			{ risky: true, p: 0.2, rules: "pass" },
			{ risky: true, p: 0.4, rules: "pass" },
			{ risky: false, p: 0.05, rules: "pass" },
			{ risky: false, p: 0.3, rules: "pass" },
		]);
		expect(lines).toEqual({ blockAbove: 0.3, escalateBand: [0.2, 0.3] });
		expect(lineVerdict(0.19, lines)).toBe("allow");
		expect(lineVerdict(0.2, lines)).toBe("escalate");
		expect(lineVerdict(0.31, lines)).toBe("block");
	});

	test("rounding goes outward", () => {
		expect(roundDown(0.0968987)).toBe(0.096898);
		expect(roundUp(0.2174861)).toBe(0.217487);
	});
});

describe("committed 8J calibration", () => {
	const MODEL = "8j-20261014-125031";
	const cal = loadCalibration(MODEL, "8j");
	const results = JSON.parse(
		readFileSync(join(import.meta.dir, "..", "results", `2026-10-23-8j-${MODEL}.json`), "utf8"),
	) as {
		rows: Array<{ risky: boolean; split: string; p: number; rules: string }>;
		test: {
			n: number;
			risky: number;
			safe: number;
			bashGuard: { falseAllows: number; safeBlocked: number };
		};
	};

	test("loads through loadCalibration and maps to the same raw lines", () => {
		expect(cal).not.toBeNull();
		const raw = toRawGuardOptions(cal as NonNullable<typeof cal>);
		expect(raw.escalateBand[0]).toBeCloseTo((cal as NonNullable<typeof cal>).escalateBand[0], 9);
		expect(raw.blockAbove).toBeCloseTo((cal as NonNullable<typeof cal>).blockAbove, 9);
	});

	test("the stored lines keep the tune guarantees: no risky-pass allowed, no safe blocked", () => {
		const c = cal as NonNullable<typeof cal>;
		const lines = { blockAbove: c.blockAbove, escalateBand: c.escalateBand as [number, number] };
		const tune = results.rows.filter((r) => r.split === "tune");
		expect(
			tune.filter((r) => r.risky && r.rules === "pass" && lineVerdict(r.p, lines) === "allow"),
		).toEqual([]);
		expect(tune.filter((r) => !r.risky && lineVerdict(r.p, lines) === "block")).toEqual([]);
	});

	test("held-out numbers in the calibration match the results file's test split", () => {
		const c = cal as NonNullable<typeof cal>;
		const t = results.test;
		expect(c.heldOut.recall).toBeCloseTo((t.risky - t.bashGuard.falseAllows) / t.risky, 12);
		expect(c.heldOut.falseBlock).toBeCloseTo(t.bashGuard.safeBlocked / t.safe, 12);
		expect(results.rows.filter((r) => r.split === "test").length).toBe(t.n);
	});
});
