/** Bake-off scoring on a hand-computed fixture: four cases, two models. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelRun, renderTable, scoreModels, writeJson } from "./bakeoff";

// Expected: c1 deny, c2 deny, c3 allow, c4 allow.
const MB = 1048576;
const runs: ModelRun[] = [
	{
		model: "8j",
		weightsPath: "/local/8j.gguf",
		fileBytes: 100 * MB,
		peakRssBytes: 200 * MB,
		cases: [
			{ id: "c1", verdict: "deny", expected: "deny", latencyMs: 10 },
			{ id: "c2", verdict: "deny", expected: "deny", latencyMs: 20 },
			{ id: "c3", verdict: "allow", expected: "allow", latencyMs: 30 },
			{ id: "c4", verdict: "deny", expected: "allow", latencyMs: 40 },
		],
	},
	{
		model: "jev",
		fileBytes: 50 * MB,
		peakRssBytes: 80 * MB,
		cases: [
			{ id: "c1", verdict: "allow", expected: "deny", latencyMs: 5 },
			{ id: "c2", verdict: "deny", expected: "deny", latencyMs: 15 },
			{ id: "c3", verdict: "allow", expected: "allow", latencyMs: 25 },
			{ id: "c4", verdict: "allow", expected: "allow", latencyMs: 35 },
		],
	},
];

describe("bakeoff", () => {
	test("each metric, exactly", () => {
		const [a, b] = scoreModels(runs);
		expect(a).toEqual({
			model: "8j",
			cases: 4,
			accuracy: 0.75,
			falseAllowRate: 0,
			p50Ms: 20,
			p95Ms: 40,
			peakRssBytes: 200 * MB,
			fileBytes: 100 * MB,
		});
		expect(b).toEqual({
			model: "jev",
			cases: 4,
			accuracy: 0.75,
			falseAllowRate: 0.5,
			p50Ms: 15,
			p95Ms: 35,
			peakRssBytes: 80 * MB,
			fileBytes: 50 * MB,
		});
	});

	test("no expected denials gives a null false-allow rate", () => {
		const only = { ...runs[0], cases: [runs[0].cases[2]] };
		expect(scoreModels([only])[0].falseAllowRate).toBeNull();
	});

	test("table and json are byte-identical twice", () => {
		const once = () => [renderTable(scoreModels(runs)), writeJson(scoreModels(runs))];
		expect(once()).toEqual(once());
		expect(renderTable(scoreModels(runs)).split("\n")[0]).toMatch(
			/^model +cases +accuracy +false-allow/,
		);
	});

	describe("cli errors", () => {
		const dir = mkdtempSync(join(tmpdir(), "bakeoff-"));
		const run = (name: string, content?: string) => {
			const f = join(dir, name);
			if (content !== undefined) writeFileSync(f, content);
			const r = Bun.spawnSync(["bun", join(import.meta.dir, "bakeoff.ts"), "--from", f]);
			return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString().trim(), f };
		};
		test("missing file", () => {
			const r = run("none.json");
			expect([r.code, r.out, r.err]).toEqual([2, "", `${r.f}: no such file`]);
		});
		test("malformed JSON", () => {
			const r = run("bad.json", "[\n{bad");
			expect([r.code, r.out, r.err]).toEqual([2, "", `${r.f}: not valid JSON at line 2`]);
		});
		test("wrong shape", () => {
			const r = run("shape.json", "{}");
			expect(r.code).toBe(2);
			expect(r.out).toBe("");
			expect(r.err).toBe(
				`${r.f}: expected an array of runs with model, cases, latencyMs, peakRssBytes, fileBytes`,
			);
		});
	});
});
