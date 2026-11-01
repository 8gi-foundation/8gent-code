/**
 * Tests for the frozen hold-out validator + canary seam.
 *
 * These assert the SAFETY invariants of the self-learning loop:
 *   1. The validator writes a `holdout-results.json` whose `perTask` key matches
 *      the contract training.ts reads (packages/kernel/training.ts:411).
 *   2. A missing / empty / unsealed hold-out yields a gate-REJECT result
 *      (perTask = {}, measured=false) — fail closed, never a pass.
 *   3. A candidate identical to baseline does NOT pass the gate's margin
 *      (holdOutBeats ties are OK, but the *promotion* requires the gate's full
 *      chain; here we prove identical scores never clear a strict-improvement bar).
 *   4. The frozen hold-out set is STRUCTURALLY separate from training: it is
 *      marked _frozen/_never_train_on, lives under holdout/, and the loader
 *      refuses any file lacking that marker.
 *   5. The canary seam returns INCONCLUSIVE on no traffic (fail closed).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holdOutBeats } from "../../packages/kernel/promotion-gate";
import { measureCanary, loadRecentTraffic } from "./canary-measure";
import {
	DEFAULT_HOLDOUT_PATH,
	type HoldOutItem,
	type ModelTarget,
	loadHoldOut,
	runHoldOut,
	scoreItem,
} from "./validate-holdout";

const CAND: ModelTarget = { url: "http://candidate", model: "ckpt-candidate", label: "candidate" };
const BASE: ModelTarget = { url: "http://baseline", model: "base-model", label: "baseline" };

// A deterministic fake model: returns the exact expected answer for a known
// set of prompts, otherwise an empty string.
function fakeModelFromAnswers(answers: Record<string, string | null>) {
	return async (_t: ModelTarget, prompt: string): Promise<string | null> => {
		if (prompt in answers) return answers[prompt];
		return "";
	};
}

function writeHoldout(lines: object[]): string {
	const dir = mkdtempSync(join(tmpdir(), "holdout-"));
	const path = join(dir, "set.jsonl");
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
	return path;
}

const FROZEN_META = { _frozen: true, _never_train_on: true, _holdout_id: "test-set" };

describe("objective scoring (no cloud judge)", () => {
	test("exact match is case-insensitive trimmed", () => {
		const item: HoldOutItem = { id: "a", prompt: "", expected: "391", match: "exact" };
		expect(scoreItem(item, "  391 ")).toBe(100);
		expect(scoreItem(item, "392")).toBe(0);
	});

	test("json match is order-independent and fence-tolerant", () => {
		const item: HoldOutItem = {
			id: "j",
			prompt: "",
			expected: '{"name":"eight","ok":true}',
			match: "json",
		};
		expect(scoreItem(item, '```json\n{"ok": true, "name": "eight"}\n```')).toBe(100);
		expect(scoreItem(item, '{"ok": false, "name": "eight"}')).toBe(0);
	});

	test("contains_normalized ignores whitespace and quotes", () => {
		const item: HoldOutItem = {
			id: "c",
			prompt: "",
			expected: 's.split("").reverse().join("")',
			match: "contains_normalized",
		};
		expect(scoreItem(item, "Here you go: s.split('').reverse().join('')")).toBe(100);
	});
});

describe("frozen hold-out loader (anti-train-on-test guarantee)", () => {
	test("the shipped frozen set v1 loads, is sealed, and has eval items", () => {
		const { id, items } = loadHoldOut(DEFAULT_HOLDOUT_PATH);
		expect(id).toBe("holdout-v1");
		expect(items.length).toBeGreaterThan(0);
		// Metadata line is NOT counted as an eval item.
		expect(items.every((i) => !i.id.startsWith("_"))).toBe(true);
	});

	test("the shipped frozen set declares itself never-train-on (structural separation)", () => {
		const raw = readFileSync(DEFAULT_HOLDOUT_PATH, "utf-8");
		const firstLine = raw.split("\n").find((l) => l.trim().length > 0)!;
		const meta = JSON.parse(firstLine);
		expect(meta._frozen).toBe(true);
		expect(meta._never_train_on).toBe(true);
		// And it physically lives under a holdout/ directory, apart from training data.
		expect(DEFAULT_HOLDOUT_PATH).toContain("/holdout/");
	});

	test("a file WITHOUT the frozen marker is refused (treated as empty -> reject)", () => {
		// Simulates a training file accidentally passed in: no _frozen marker.
		const path = writeHoldout([
			{ id: "x", prompt: "p", expected: "e", match: "exact" },
		]);
		const { id, items } = loadHoldOut(path);
		expect(items.length).toBe(0);
		expect(id).toBe("UNSEALED");
	});

	test("a missing file yields MISSING with no items", () => {
		const { id, items } = loadHoldOut(join(tmpdir(), "does-not-exist-xyz.jsonl"));
		expect(id).toBe("MISSING");
		expect(items.length).toBe(0);
	});
});

describe("validator writes the right-shaped json (contract with training.ts)", () => {
	test("perTask is a taskId->candidateScore map matching item ids", async () => {
		const path = writeHoldout([
			FROZEN_META,
			{ id: "t1", prompt: "p1", expected: "yes", match: "exact" },
			{ id: "t2", prompt: "p2", expected: "no", match: "exact" },
		]);
		const cand = fakeModelFromAnswers({ p1: "yes", p2: "no" });
		const base = fakeModelFromAnswers({ p1: "yes", p2: "no" });
		const result = await runHoldOut({
			holdOutPath: path,
			candidate: CAND,
			baseline: BASE,
			caller: async (t, prompt) => (t.label === "candidate" ? cand(t, prompt) : base(t, prompt)),
		});

		// The load-bearing contract key.
		expect(result.perTask).toEqual({ t1: 100, t2: 100 });
		// The documented metadata keys exist and are honest.
		expect(result.holdout_id).toBe("test-set");
		expect(result.n).toBe(2);
		expect(result.candidate_score).toBe(100);
		expect(result.baseline_score).toBe(100);
		expect(typeof result.timestamp).toBe("string");
		expect(result.breakdown.length).toBe(2);
		expect(result.measured).toBe(true);
	});

	test("training.ts contract: it reads results.perTask as Record<string,number>", async () => {
		// Mirror exactly what training.ts:411 does with the file.
		const path = writeHoldout([
			FROZEN_META,
			{ id: "t1", prompt: "p1", expected: "42", match: "exact" },
		]);
		const result = await runHoldOut({
			holdOutPath: path,
			candidate: CAND,
			baseline: BASE,
			caller: fakeModelFromAnswers({ p1: "42" }),
		});
		const serialized = JSON.parse(JSON.stringify(result));
		const perTask = (serialized.perTask as Record<string, number>) ?? {};
		expect(perTask).toEqual({ t1: 100 });
	});
});

describe("FAIL CLOSED: missing/empty hold-out -> gate REJECT", () => {
	test("empty hold-out -> perTask {} and holdOutBeats rejects", async () => {
		const path = writeHoldout([FROZEN_META]); // metadata only, zero items
		const result = await runHoldOut({
			holdOutPath: path,
			candidate: CAND,
			baseline: BASE,
			caller: fakeModelFromAnswers({}),
		});
		expect(result.perTask).toEqual({});
		expect(result.measured).toBe(false);
		// The gate rejects an empty hold-out.
		const decision = holdOutBeats({ tasks: {}, sealedAt: "" }, { tasks: result.perTask });
		expect(decision.ok).toBe(false);
	});

	test("missing hold-out file -> perTask {} -> gate cannot certify", async () => {
		const result = await runHoldOut({
			holdOutPath: join(tmpdir(), "nope-missing.jsonl"),
			candidate: CAND,
			baseline: BASE,
			caller: fakeModelFromAnswers({}),
		});
		expect(result.perTask).toEqual({});
		expect(result.status).toContain("FAIL-CLOSED");
	});

	test("candidate model failure OMITS the task -> gate counts it as a regression", async () => {
		const path = writeHoldout([
			FROZEN_META,
			{ id: "t1", prompt: "p1", expected: "ok", match: "exact" },
			{ id: "t2", prompt: "p2", expected: "ok", match: "exact" },
		]);
		// Candidate fails on p2 (returns null), baseline answers both.
		const caller = async (t: ModelTarget, prompt: string): Promise<string | null> => {
			if (t.label === "candidate") return prompt === "p2" ? null : "ok";
			return "ok";
		};
		const result = await runHoldOut({ holdOutPath: path, candidate: CAND, baseline: BASE, caller });
		// t2 omitted from perTask.
		expect(result.perTask).toEqual({ t1: 100 });
		expect(result.measured).toBe(false);
		// Gate: baseline bar has both t1 and t2; t2 missing on candidate -> reject.
		const decision = holdOutBeats(
			{ tasks: { t1: 100, t2: 100 }, sealedAt: "" },
			{ tasks: result.perTask },
		);
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("t2");
	});
});

describe("identical candidate==baseline does NOT clear a strict-improvement margin", () => {
	test("a tie is not an improvement: candidate_score == baseline_score", async () => {
		const path = writeHoldout([
			FROZEN_META,
			{ id: "t1", prompt: "p1", expected: "x", match: "exact" },
		]);
		// Identical model behaviour for candidate and baseline.
		const caller = fakeModelFromAnswers({ p1: "x" });
		const result = await runHoldOut({ holdOutPath: path, candidate: CAND, baseline: BASE, caller });
		expect(result.candidate_score).toBe(result.baseline_score);
		// A strict-improvement gate (candidate must BEAT baseline by a margin)
		// must reject equality. holdOutBeats allows ties (no regression), but the
		// promotion still needs a positive margin somewhere in the chain; here we
		// assert the measured delta is zero, so any margin > 0 requirement fails.
		const margin = 0.0; // require candidate to beat baseline by > 0
		expect(result.candidate_score - result.baseline_score).toBe(0);
		expect(result.candidate_score - result.baseline_score > margin).toBe(false);
	});

	test("hold-out tie is no-regression (gate's holdOutBeats allows beat-or-tie)", () => {
		// Document the exact gate semantics: tie passes holdOutBeats (no regression)
		// but provides no positive margin — the canary/strict-margin layer must add it.
		const decision = holdOutBeats(
			{ tasks: { t1: 100 }, sealedAt: "" },
			{ tasks: { t1: 100 } },
		);
		expect(decision.ok).toBe(true); // beat-or-tie
		const regress = holdOutBeats(
			{ tasks: { t1: 100 }, sealedAt: "" },
			{ tasks: { t1: 99 } },
		);
		expect(regress.ok).toBe(false); // any regression rejects
	});
});

describe("canary seam (read-only, fail-closed)", () => {
	test("no recent traffic -> INCONCLUSIVE (turns=0), which the gate rejects", async () => {
		const m = await measureCanary({ candidate: CAND, baseline: BASE, traffic: [] });
		expect(m.measured).toBe(false);
		expect(m.turns).toBe(0);
		expect(m.status).toContain("INCONCLUSIVE");
	});

	test("loadRecentTraffic returns [] for a missing file", () => {
		expect(loadRecentTraffic(join(tmpdir(), "no-traffic.jsonl"), 50)).toEqual([]);
	});

	test("with graded traffic, emits a CanarySignal-shaped 0..1 score", async () => {
		const traffic = [
			{ prompt: "p1", expected: "yes", match: "exact" as const },
			{ prompt: "p2", expected: "no", match: "exact" as const },
		];
		// Candidate gets both right; baseline gets one right.
		const caller = async (t: ModelTarget, prompt: string): Promise<string | null> => {
			if (t.label === "candidate") return prompt === "p1" ? "yes" : "no";
			return prompt === "p1" ? "yes" : "WRONG";
		};
		const m = await measureCanary({ candidate: CAND, baseline: BASE, traffic, caller });
		expect(m.turns).toBe(2);
		expect(m.errors).toBe(0);
		expect(m.candidateAvgScore).toBeGreaterThanOrEqual(m.activeAvgScore);
		expect(m.candidateAvgScore).toBeLessThanOrEqual(1);
		expect(m.activeAvgScore).toBeLessThanOrEqual(1);
	});

	test("a candidate that fails calls is counted as canary errors", async () => {
		const traffic = [{ prompt: "p1", expected: "yes", match: "exact" as const }];
		const caller = async (t: ModelTarget, _p: string): Promise<string | null> =>
			t.label === "candidate" ? null : "yes";
		const m = await measureCanary({ candidate: CAND, baseline: BASE, traffic, caller });
		expect(m.turns).toBe(1);
		expect(m.errors).toBe(1);
	});
});
