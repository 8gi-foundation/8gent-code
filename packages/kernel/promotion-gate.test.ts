import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CanarySignal,
	DEFAULT_PROMOTION_POLICY,
	type HoldOut,
	type PromotionPolicy,
	type PromotionRequest,
	evaluatePromotion,
	holdOutBeats,
	loadPromotionPolicy,
	readRollbackManifest,
	writeRollbackManifest,
} from "./promotion-gate";

const holdOut: HoldOut = {
	tasks: { taskA: 70, taskB: 80 },
	sealedAt: "2026-01-01T00:00:00.000Z",
};

const healthyCanary: CanarySignal = {
	turns: 60,
	errors: 0,
	candidateAvgScore: 0.9,
	activeAvgScore: 0.85,
};

function req(overrides: Partial<PromotionRequest>): PromotionRequest {
	return {
		candidateId: "ckpt-1",
		bump: "patch",
		holdOut,
		holdOutResult: { tasks: { taskA: 75, taskB: 82 } }, // beats both
		canary: healthyCanary,
		...overrides,
	};
}

describe("promotion gate (P0-2)", () => {
	test("autoPromote DEFAULT is FALSE (the landmine, defused)", () => {
		expect(DEFAULT_PROMOTION_POLICY.autoPromote).toBe(false);
	});

	test("autonomy DEFAULT is Level 0 (human-confirm every promotion)", () => {
		expect(DEFAULT_PROMOTION_POLICY.autonomy).toBe(0);
	});

	test("with default policy, NOTHING promotes (autoPromote disabled)", () => {
		const d = evaluatePromotion(req({}), DEFAULT_PROMOTION_POLICY);
		expect(d.promote).toBe(false);
		expect(d.blockedBy).toBe("disabled");
	});

	test("NO promotion without a frozen hold-out beat (regression on any task rejects)", () => {
		const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, autoPromote: true, autonomy: 1 };
		const d = evaluatePromotion(
			req({ holdOutResult: { tasks: { taskA: 75, taskB: 79 } } }), // taskB regresses 80->79
			policy,
		);
		expect(d.promote).toBe(false);
		expect(d.blockedBy).toBe("holdout");
	});

	test("hold-out missing a sealed task counts as a regression (fail closed)", () => {
		const d = holdOutBeats(holdOut, { tasks: { taskA: 75 } });
		expect(d.ok).toBe(false);
	});

	test("empty hold-out cannot certify -> rejected", () => {
		const d = holdOutBeats({ tasks: {}, sealedAt: "" }, { tasks: {} });
		expect(d.ok).toBe(false);
	});

	test("patch auto-promotes at autonomy 1 inside canary bounds (no human token needed)", () => {
		const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, autoPromote: true, autonomy: 1 };
		const d = evaluatePromotion(req({ bump: "patch" }), policy);
		expect(d.promote).toBe(true);
	});

	test("patch at autonomy 0 still requires human confirm", () => {
		const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, autoPromote: true, autonomy: 0 };
		const d = evaluatePromotion(req({ bump: "patch" }), policy);
		expect(d.promote).toBe(false);
		expect(d.blockedBy).toBe("human-confirm");
	});

	test("minor ALWAYS requires human confirm, even at autonomy 1", () => {
		const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, autoPromote: true, autonomy: 1 };
		const blocked = evaluatePromotion(req({ bump: "minor" }), policy);
		expect(blocked.promote).toBe(false);
		expect(blocked.blockedBy).toBe("human-confirm");

		const ok = evaluatePromotion(
			req({ bump: "minor", humanConfirm: { approved: true, candidateId: "ckpt-1" } }),
			policy,
		);
		expect(ok.promote).toBe(true);
	});

	test("major is NEVER auto-promoted; human confirm mandatory", () => {
		const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, autoPromote: true, autonomy: 2 };
		const blocked = evaluatePromotion(req({ bump: "major" }), policy);
		expect(blocked.promote).toBe(false);

		const ok = evaluatePromotion(
			req({ bump: "major", humanConfirm: { approved: true, candidateId: "ckpt-1" } }),
			policy,
		);
		expect(ok.promote).toBe(true);
	});

	test("canary incomplete or unhealthy blocks promotion", () => {
		const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, autoPromote: true, autonomy: 1 };
		const incomplete = evaluatePromotion(
			req({ canary: { turns: 5, errors: 0, candidateAvgScore: 0.9, activeAvgScore: 0.8 } }),
			policy,
		);
		expect(incomplete.promote).toBe(false);
		expect(incomplete.blockedBy).toBe("canary");

		const regressing = evaluatePromotion(
			req({ canary: { turns: 60, errors: 0, candidateAvgScore: 0.7, activeAvgScore: 0.85 } }),
			policy,
		);
		expect(regressing.promote).toBe(false);
		expect(regressing.blockedBy).toBe("canary");
	});

	test("NO model promotes without ALL of: hold-out beat + canary + human confirm (minor)", () => {
		const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, autoPromote: true, autonomy: 0 };
		// Each missing piece independently blocks.
		expect(evaluatePromotion(req({ bump: "minor", canary: undefined }), policy).promote).toBe(
			false,
		);
		expect(
			evaluatePromotion(
				req({ bump: "minor", holdOutResult: { tasks: { taskA: 60, taskB: 82 } } }),
				policy,
			).promote,
		).toBe(false);
		expect(evaluatePromotion(req({ bump: "minor" }), policy).promote).toBe(false);
		// Only all three present -> promote.
		expect(
			evaluatePromotion(
				req({ bump: "minor", humanConfirm: { approved: true, candidateId: "ckpt-1" } }),
				policy,
			).promote,
		).toBe(true);
	});

	test("loadPromotionPolicy fails CLOSED on a partial file (cannot silently enable)", () => {
		const dir = mkdtempSync(join(tmpdir(), "promo-"));
		const path = join(dir, "promotion-policy.json");
		writeFileSync(path, JSON.stringify({ canaryFraction: 0.1 })); // no autoPromote key
		const policy = loadPromotionPolicy(path);
		expect(policy.autoPromote).toBe(false);
		expect(policy.canaryFraction).toBe(0.1);
	});

	test("loadPromotionPolicy on unreadable file returns safe default", () => {
		const dir = mkdtempSync(join(tmpdir(), "promo-"));
		const path = join(dir, "promotion-policy.json");
		writeFileSync(path, "{ not json");
		expect(loadPromotionPolicy(path).autoPromote).toBe(false);
	});

	test("rollback manifest round-trips and is written before any swap", () => {
		const dir = mkdtempSync(join(tmpdir(), "promo-"));
		const path = join(dir, "promotion-policy.json");
		writeRollbackManifest(
			{
				activeVersion: "ckpt-old",
				previousVersion: "ckpt-1",
				weightsPath: "/weights/ckpt-1",
				baselineSnapshot: { taskA: 70 },
			},
			path,
		);
		const m = readRollbackManifest(path);
		expect(m?.activeVersion).toBe("ckpt-old");
		expect(m?.weightsPath).toBe("/weights/ckpt-1");
		expect(typeof m?.writtenAt).toBe("string");
		// Manifest stored under `rollback` key alongside any policy.
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		expect(raw.rollback).toBeDefined();
	});

	test("readRollbackManifest returns null when none recorded", () => {
		const dir = mkdtempSync(join(tmpdir(), "promo-"));
		expect(readRollbackManifest(join(dir, "nope.json"))).toBe(null);
	});
});
