/**
 * Tests for the held-out mutation gate (#3556). FAKE rerun only: no model is
 * called, nothing touches the network, files go to a temp dir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendProposal, decide, gateCandidates, isGateEnabled, splitIds } from "./mutation-gate";

const IDS = [
	"BF001",
	"BF002",
	"BF003",
	"FI001",
	"FS001",
	"FS002",
	"MR001",
	"SD001",
	"TC001",
	"DP001",
];

describe("isGateEnabled", () => {
	test("off by default, on only for AUTORESEARCH_GATE=1", () => {
		expect(isGateEnabled({})).toBe(false);
		expect(isGateEnabled({ AUTORESEARCH_GATE: "0" })).toBe(false);
		expect(isGateEnabled({ AUTORESEARCH_GATE: "true" })).toBe(false);
		expect(isGateEnabled({ AUTORESEARCH_GATE: "1" })).toBe(true);
	});
});

describe("splitIds", () => {
	test("deterministic, disjoint, covers every id", () => {
		const a = splitIds(IDS);
		const b = splitIds([...IDS].reverse());
		expect(a).toEqual(b);
		expect(a.heldOut.filter((id) => a.tuning.includes(id))).toEqual([]);
		expect([...a.tuning, ...a.heldOut].sort()).toEqual([...IDS].sort());
		expect(a.heldOut.length).toBe(3); // ceil(10 * 30%)
	});

	test("both sides non-empty from two ids up; one id is all tuning", () => {
		const two = splitIds(["A1", "B2"]);
		expect(two.tuning.length).toBe(1);
		expect(two.heldOut.length).toBe(1);
		expect(splitIds(["A1"]).heldOut).toEqual([]);
	});
});

describe("decide", () => {
	const split = { tuning: ["T1", "T2"], heldOut: ["H1"] };

	test("keeps when tuning rises by the margin and held-out does not drop", () => {
		const d = decide({ T1: 40, T2: 40, H1: 50 }, { T1: 60, T2: 40, H1: 50 }, split);
		expect(d.keep).toBe(true);
		expect(d.tuningBefore).toBe(40);
		expect(d.tuningAfter).toBe(50);
	});

	test("discards a rule that lifts tuning but hurts unseen tasks (leakage)", () => {
		const d = decide({ T1: 40, T2: 40, H1: 70 }, { T1: 100, T2: 100, H1: 60 }, split);
		expect(d.keep).toBe(false);
		expect(d.reason).toContain("held-out");
	});

	test("discards a rule that does not move tuning", () => {
		const d = decide({ T1: 40, T2: 40, H1: 50 }, { T1: 40, T2: 40, H1: 55 }, split);
		expect(d.keep).toBe(false);
		expect(d.reason).toContain("tuning");
	});

	test("missing scores count as 0, and an empty held-out set fails closed", () => {
		expect(decide({ T1: 40, T2: 40, H1: 50 }, { T1: 90, T2: 90 }, split).keep).toBe(false);
		const noHeld = decide({ T1: 0 }, { T1: 100 }, { tuning: ["T1"], heldOut: [] });
		expect(noHeld.keep).toBe(false);
		expect(noHeld.reason).toContain("empty");
	});
});

describe("gateCandidates", () => {
	const split = { tuning: ["T1"], heldOut: ["H1"] };

	function harness(after: Record<string, number> | Error) {
		let active: string[] = ["[OLD] keep me"];
		const seenDuringRerun: string[][] = [];
		return {
			get active() {
				return active;
			},
			seenDuringRerun,
			apply: (ms: string[]) => {
				active = [...ms];
			},
			rerun: async () => {
				seenDuringRerun.push([...active]);
				if (after instanceof Error) throw after;
				return after;
			},
		};
	}

	test("a winning batch stays active and is reported as kept", async () => {
		const h = harness({ T1: 80, H1: 50 });
		const r = await gateCandidates({
			candidates: ["[T1] new rule"],
			accepted: ["[OLD] keep me"],
			before: { T1: 40, H1: 50 },
			split,
			apply: h.apply,
			rerun: h.rerun,
		});
		expect(h.seenDuringRerun).toEqual([["[OLD] keep me", "[T1] new rule"]]);
		expect(r.keep).toBe(true);
		expect(r.kept).toEqual(["[T1] new rule"]);
		expect(h.active).toEqual(["[OLD] keep me", "[T1] new rule"]);
	});

	test("a losing batch is removed from the prompt", async () => {
		const h = harness({ T1: 90, H1: 20 });
		const r = await gateCandidates({
			candidates: ["[T1] answer key"],
			accepted: ["[OLD] keep me"],
			before: { T1: 40, H1: 50 },
			split,
			apply: h.apply,
			rerun: h.rerun,
		});
		expect(r.keep).toBe(false);
		expect(r.discarded).toEqual(["[T1] answer key"]);
		expect(h.active).toEqual(["[OLD] keep me"]);
	});

	test("a failed rerun restores the prompt and keeps nothing", async () => {
		const h = harness(new Error("model down"));
		const r = await gateCandidates({
			candidates: ["[T1] new rule"],
			accepted: ["[OLD] keep me"],
			before: { T1: 40, H1: 50 },
			split,
			apply: h.apply,
			rerun: h.rerun,
		});
		expect(r.keep).toBe(false);
		expect(r.reason).toContain("model down");
		expect(h.active).toEqual(["[OLD] keep me"]);
	});

	test("no candidates means no rerun", async () => {
		const h = harness({ T1: 0, H1: 0 });
		const r = await gateCandidates({
			candidates: [],
			accepted: ["[OLD] keep me"],
			before: { T1: 40, H1: 50 },
			split,
			apply: h.apply,
			rerun: h.rerun,
		});
		expect(r.keep).toBe(false);
		expect(h.seenDuringRerun).toEqual([]);
	});
});

describe("appendProposal", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("appends one JSON line per kept batch, creating the directory", () => {
		dir = mkdtempSync(join(tmpdir(), "mutation-gate-"));
		const file = join(dir, "nested", "proposals.jsonl");
		appendProposal(file, { iteration: 1, kept: ["a"] });
		appendProposal(file, { iteration: 2, kept: ["b"] });
		expect(existsSync(file)).toBe(true);
		const lines = readFileSync(file, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.iteration)).toEqual([1, 2]);
	});
});
