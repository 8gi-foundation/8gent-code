/**
 * Tests for the held-out mutation gate (#3556). FAKE rerun only: no model is
 * called, nothing touches the network, files go to a temp dir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendProposal,
	decide,
	dropHeldOutMutations,
	gateCandidates,
	isGateEnabled,
	mutationSourceId,
	scoreAll,
	splitIds,
} from "./mutation-gate";

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

describe("dropHeldOutMutations (restored state cannot contaminate held-out)", () => {
	test("reads the source id from the rule prefix", () => {
		expect(mutationSourceId("[LH001] do x")).toBe("LH001");
		expect(mutationSourceId("no prefix")).toBeNull();
	});

	test("drops rules whose source id is held out, keeps the rest in order", () => {
		const split = { tuning: ["SD001", "BF004"], heldOut: ["LH001", "MR001"] };
		const r = dropHeldOutMutations(
			["[SD001] a", "[LH001] b", "general rule", "[MR001] c", "[BF004] d"],
			split,
		);
		expect(r.kept).toEqual(["[SD001] a", "general rule", "[BF004] d"]);
		expect(r.dropped).toEqual(["[LH001] b", "[MR001] c"]);
	});

	test("the tracked loop-state.json LH rules are all dropped when LH ids are held out", () => {
		const state = JSON.parse(readFileSync(join(import.meta.dir, "loop-state.json"), "utf-8"));
		const lh = (state.mutations as string[]).filter((m) => /^\[LH00[1-5]\]/.test(m));
		expect(lh.length).toBeGreaterThan(0);
		const split = { tuning: ["SD001"], heldOut: ["LH001", "LH002", "LH003", "LH004", "LH005"] };
		const r = dropHeldOutMutations(state.mutations, split);
		expect(r.kept.filter((m) => /^\[LH00[1-5]\]/.test(m))).toEqual([]);
		expect(r.dropped.length).toBe(lh.length);
	});
});

describe("scoreAll (rerun matches the sweep: a failing benchmark scores 0)", () => {
	const items = [{ id: "T1" }, { id: "BOOM" }, { id: "H1" }];
	const score = async (b: { id: string }) => {
		if (b.id === "BOOM") throw new Error("All temps failed for BOOM");
		return b.id === "T1" ? 70 : 60;
	};

	test("one throwing benchmark scores 0 and does not abort the rest", async () => {
		const errors: string[] = [];
		const s = await scoreAll(items, score, (b) => errors.push(b.id));
		expect(s).toEqual({ T1: 70, BOOM: 0, H1: 60 });
		expect(errors).toEqual(["BOOM"]);
	});

	test("the gate still decides on the merits when one benchmark always fails", async () => {
		const r = await gateCandidates({
			candidates: ["[T1] new"],
			accepted: [],
			before: { T1: 40, BOOM: 0, H1: 50 },
			split: { tuning: ["T1", "BOOM"], heldOut: ["H1"] },
			apply: () => {},
			rerun: () => scoreAll(items, score),
		});
		expect(r.reason).not.toContain("rerun failed");
		expect(r.keep).toBe(true);
		expect(r.after.BOOM).toBe(0);
	});
});
