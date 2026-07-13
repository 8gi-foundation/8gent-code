/**
 * Tests for the MoA router - the learned per-task-class model chooser. The
 * bandit is driven with a seeded RNG so Thompson sampling is deterministic;
 * no network, no model call, no real home directory.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageRecord } from "../orchestration/adaptive-pipeline";
import { RouterBandit, seededRng } from "../providers/router-bandit";
import { MoaRouter, qualityFromStage, stageCapabilityClass } from "./moa-router";

function stage(over: Partial<StageRecord>): StageRecord {
	return {
		stage: "engineer",
		provider: "ollama",
		model: "gemma",
		attempts: 1,
		ms: 1000,
		ok: true,
		obstacles: [],
		...over,
	};
}

describe("stageCapabilityClass", () => {
	test("maps planning/compaction stages to writing", () => {
		expect(stageCapabilityClass("orchestrator")).toBe("writing");
		expect(stageCapabilityClass("context")).toBe("writing");
	});
	test("maps engineer and repair passes to code", () => {
		expect(stageCapabilityClass("engineer")).toBe("code");
		expect(stageCapabilityClass("repair-1")).toBe("code");
		expect(stageCapabilityClass("repair-3")).toBe("code");
	});
	test("maps qa to judge", () => {
		expect(stageCapabilityClass("qa")).toBe("judge");
	});
	test("defaults an unknown stage to code", () => {
		expect(stageCapabilityClass("mystery-stage")).toBe("code");
	});
});

describe("qualityFromStage", () => {
	test("a clean pass is full reward", () => {
		expect(qualityFromStage({ ok: true, obstacles: [] })).toBe(1.0);
	});
	test("a pass that hit obstacles is discounted", () => {
		expect(qualityFromStage({ ok: true, obstacles: ["timeout"] })).toBe(0.7);
	});
	test("a failed stage still gets a little credit", () => {
		expect(qualityFromStage({ ok: false, obstacles: ["syntax error"] })).toBe(0.2);
	});
});

describe("MoaRouter.chooseModel", () => {
	test("returns undefined when there are no candidates", () => {
		const router = new MoaRouter({ rng: seededRng(1) });
		expect(router.chooseModel("engineer", [])).toBeUndefined();
	});

	test("only ever returns one of the candidates it was given", () => {
		const router = new MoaRouter({ rng: seededRng(7) });
		const candidates = [
			{ provider: "ollama", model: "gemma" },
			{ provider: "lmstudio", model: "ornith-9b" },
		];
		for (let i = 0; i < 20; i++) {
			const chosen = router.chooseModel("engineer", candidates);
			expect(chosen).toBeDefined();
			if (!chosen) continue;
			expect(candidates).toContainEqual(chosen);
		}
	});

	test("preserves the caller's rich element type (returns the same object)", () => {
		const router = new MoaRouter({ rng: seededRng(3) });
		const rich = [
			{ provider: "ollama", model: "gemma", score: 5, tag: "a" },
			{ provider: "lmstudio", model: "ornith-9b", score: 8, tag: "b" },
		];
		const chosen = router.chooseModel("engineer", rich);
		// A candidate object, not a stripped {provider,model}: the extra field survives.
		expect(chosen && "tag" in chosen).toBe(true);
	});

	test("after learning, favours the arm that has earned the class", () => {
		// Two arms in the same class. Teach the bandit that arm B always wins
		// and arm A always loses, then confirm selection concentrates on B.
		const bandit = new RouterBandit({ rng: seededRng(11) });
		const router = new MoaRouter({ bandit });
		const A = { provider: "ollama", model: "weak" };
		const B = { provider: "lmstudio", model: "strong" };
		for (let i = 0; i < 40; i++) {
			router.recordStages([stage({ ...A, stage: "engineer", ok: false, obstacles: ["defect"] })]);
			router.recordStages([stage({ ...B, stage: "engineer", ok: true, obstacles: [] })]);
		}
		let bWins = 0;
		for (let i = 0; i < 50; i++) {
			if (router.chooseModel("engineer", [A, B])?.model === "strong") bWins++;
		}
		expect(bWins).toBeGreaterThan(40);
	});
});

describe("MoaRouter.recordStages + winRates", () => {
	test("folds real per-stage outcomes into the right capability class", () => {
		const router = new MoaRouter({ rng: seededRng(2) });
		router.recordStages([
			stage({ stage: "orchestrator", provider: "ollama", model: "qwen", ok: true, obstacles: [] }),
			stage({ stage: "engineer", provider: "ollama", model: "gemma", ok: true, obstacles: [] }),
			stage({ stage: "qa", provider: "ollama", model: "qwen", ok: false, obstacles: ["bad"] }),
		]);
		// orchestrator -> writing, engineer -> code, qa -> judge.
		expect(router.winRates("writing").find((r) => r.model === "qwen")?.pulls).toBe(1);
		expect(router.winRates("code").find((r) => r.model === "gemma")?.meanQuality).toBe(1.0);
		const judge = router.winRates("judge").find((r) => r.model === "qwen");
		expect(judge?.meanQuality).toBe(0.2);
	});

	test("captures measured latency and ignores a zero-ms record", () => {
		const router = new MoaRouter({ rng: seededRng(4) });
		router.recordStages([stage({ stage: "engineer", ms: 2500 })]);
		router.recordStages([stage({ stage: "engineer", ms: 0 })]); // repair rows carry ms:0
		const row = router.winRates("code").find((r) => r.model === "gemma");
		expect(row?.pulls).toBe(2);
		expect(row?.latencyMsEma).toBe(2500);
	});
});

describe("MoaRouter persistence", () => {
	test("learned stats survive a save/load round-trip", () => {
		const dir = mkdtempSync(join(tmpdir(), "moa-router-"));
		const store = join(dir, "router-bandit.json");
		try {
			const a = MoaRouter.load(store, seededRng(9));
			a.recordStages([stage({ stage: "engineer", provider: "ollama", model: "gemma" })]);
			a.save();

			const b = MoaRouter.load(store, seededRng(9));
			const row = b.winRates("code").find((r) => r.model === "gemma");
			expect(row?.pulls).toBe(1);
			expect(row?.meanQuality).toBe(1.0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
