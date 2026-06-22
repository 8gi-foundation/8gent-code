/**
 * Maker-Checker Tests
 *
 * Tests for the maker-checker pattern for high-risk actions.
 *
 * Run: bun test packages/daemon/maker-checker.test.ts
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
	MakerCheckerStore,
	AutomaticChecker,
	ACTION_STATUS,
	DEFAULT_RULES,
	CHECKER_MODE,
} from "./maker-checker";

describe("MakerCheckerStore", () => {
	let store: MakerCheckerStore;

	beforeEach(() => {
		store = new MakerCheckerStore();
	});

	describe("Rule Matching", () => {
		it("matches glob patterns", () => {
			const result = store.getRule("git:push:main", "DESTRUCTIVE");
			expect(result).not.toBeNull();
			expect(result?.actionPattern).toBe("git:push:main");
		});

		it("matches wildcard patterns", () => {
			const result = store.getRule("git:push:feature-branch", "RISKY");
			expect(result).not.toBeNull();
			expect(result?.actionPattern).toBe("git:push:*");
		});

		it("returns null for unmatched actions", () => {
			const result = store.getRule("read:file:test.txt", "SAFE");
			expect(result).toBeNull();
		});

		it("respects risk thresholds", () => {
			// shell:* rule requires BOUNDED minimum
			const boundedResult = store.getRule("shell:run:npm", "BOUNDED");
			expect(boundedResult).not.toBeNull();

			const safeResult = store.getRule("shell:run:npm", "SAFE");
			expect(safeResult).toBeNull();
		});
	});

	describe("Action Submission", () => {
		it("does not require checker for unmatchable actions", () => {
			const result = store.submitAction(
				"maker_1",
				"read:file:test.txt",
				"test.txt",
				{},
				"SAFE",
				2,
			);

			expect(result.requiresChecker).toBe(false);
			expect(result.actionId).toBeNull();
		});

		it("requires checker for matched actions", () => {
			const result = store.submitAction(
				"maker_1",
				"git:push:feature",
				"origin/feature",
				{},
				"RISKY",
				2,
			);

			expect(result.requiresChecker).toBe(true);
			expect(result.actionId).toMatch(/^act_/);
			expect(result.rule).not.toBeNull();
		});

		it("assigns correct rule based on action", () => {
			const result = store.submitAction(
				"maker_1",
				"git:push:main",
				"origin/main",
				{},
				"DESTRUCTIVE",
				4,
			);

			expect(result.rule?.checkerMode).toBe(CHECKER_MODE.HUMAN);
			expect(result.rule?.notifyOwner).toBe(true);
		});
	});

	describe("Approval Flow", () => {
		it("approves pending action", () => {
			const submit = store.submitAction(
				"maker_1",
				"shell:run:npm",
				"npm install",
				{},
				"BOUNDED",
				2,
			);

			const approved = store.approve(
				submit.actionId!,
				"checker_1",
				CHECKER_MODE.AUTOMATIC,
				"Looks good",
			);

			expect(approved).toBe(true);

			const decision = store.getDecision(submit.actionId!);
			expect(decision?.status).toBe(ACTION_STATUS.APPROVED);
			expect(decision?.checkerId).toBe("checker_1");
		});

		it("rejects pending action", () => {
			const submit = store.submitAction(
				"maker_1",
				"git:push:feature",
				"origin/feature",
				{},
				"RISKY",
				3,
			);

			const rejected = store.reject(
				submit.actionId!,
				"checker_1",
				CHECKER_MODE.HUMAN,
				"Needs review",
			);

			expect(rejected).toBe(true);

			const decision = store.getDecision(submit.actionId!);
			expect(decision?.status).toBe(ACTION_STATUS.REJECTED);
			expect(decision?.reason).toBe("Needs review");
		});

		it("cancels pending action", () => {
			const submit = store.submitAction(
				"maker_1",
				"shell:run:npm",
				"npm install",
				{},
				"BOUNDED",
				2,
			);

			const cancelled = store.cancel(submit.actionId!);
			expect(cancelled).toBe(true);
			expect(store.getPending()).toHaveLength(0);
		});

		it("lists pending actions for maker", () => {
			store.submitAction("maker_1", "shell:run:npm", "npm install", {}, "BOUNDED", 2);
			store.submitAction("maker_1", "shell:run:test", "npm test", {}, "BOUNDED", 2);
			store.submitAction("maker_2", "shell:run:build", "npm build", {}, "BOUNDED", 2);

			const maker1Pending = store.pendingForMaker("maker_1");
			expect(maker1Pending).toHaveLength(2);
		});
	});

	describe("Action Expiration", () => {
		it("expires action after timeout", () => {
			const submit = store.submitAction(
				"maker_1",
				"shell:run:npm",
				"npm install",
				{},
				"BOUNDED",
				2,
			);

			// Manually set expiresAt to past
			const pending = store.getPending()[0];
			const originalExpires = pending.expiresAt;
			(pending as any).expiresAt = Date.now() - 1000;

			// Try to approve
			const approved = store.approve(
				submit.actionId!,
				"checker_1",
				CHECKER_MODE.AUTOMATIC,
			);

			expect(approved).toBe(false);

			const decision = store.getDecision(submit.actionId!);
			expect(decision?.status).toBe(ACTION_STATUS.EXPIRED);

			// Restore
			(pending as any).expiresAt = originalExpires;
		});

		it("cleanup removes expired actions", () => {
			const submit = store.submitAction(
				"maker_1",
				"shell:run:npm",
				"npm install",
				{},
				"BOUNDED",
				2,
			);

			// Manually expire
			const pending = store.getPending()[0];
			(pending as any).expiresAt = Date.now() - 1000;

			const cleaned = store.cleanup();
			expect(cleaned).toBe(1);
			expect(store.getPending()).toHaveLength(0);
		});
	});

	describe("Custom Rules", () => {
		it("adds custom rule", () => {
			store.addRule({
				actionPattern: "deploy:*",
				minRisk: "RISKY",
				checkerMode: CHECKER_MODE.HUMAN,
				requiredRung: 3,
				timeoutMs: 300000,
				notifyOwner: true,
			});

			const result = store.getRule("deploy:production", "RISKY");
			expect(result).not.toBeNull();
			expect(result?.actionPattern).toBe("deploy:*");
		});

		it("removes rule", () => {
			store.removeRule("git:push:*");
			const result = store.getRule("git:push:feature", "RISKY");
			expect(result).toBeNull();
		});
	});

	describe("Default Rules Coverage", () => {
		it("covers git push to main (highest risk)", () => {
			const result = store.getRule("git:push:main", "DESTRUCTIVE");
			expect(result).not.toBeNull();
			expect(result?.checkerMode).toBe(CHECKER_MODE.HUMAN);
			expect(result?.notifyOwner).toBe(true);
		});

		it("covers credential access", () => {
			const result = store.getRule("credential:get", "DESTRUCTIVE");
			expect(result).not.toBeNull();
			expect(result?.checkerMode).toBe(CHECKER_MODE.HUMAN);
		});

		it("covers file deletion", () => {
			const result = store.getRule("file:delete:temp.txt", "RISKY");
			expect(result).not.toBeNull();
			expect(result?.checkerMode).toBe(CHECKER_MODE.HUMAN);
		});
	});
});

describe("AutomaticChecker", () => {
	let checker: AutomaticChecker;

	beforeEach(() => {
		checker = new AutomaticChecker();
	});

	it("can check at sufficient rung", () => {
		expect(checker.canCheck(4)).toBe(true); // AUTONOMOUS
		expect(checker.canCheck(3)).toBe(true); // DELEGATE
		expect(checker.canCheck(2)).toBe(false); // ASSIST
	});

	it("auto-approves safe actions", () => {
		const decision = checker.decide({
			actionId: "act_1",
			makerId: "maker_1",
			action: "read:file",
			target: "test.txt",
			parameters: {},
			risk: "SAFE",
			rung: 2,
			timestamp: Date.now(),
			expiresAt: Date.now() + 60000,
		});

		expect(decision.decision).toBe(ACTION_STATUS.APPROVED);
	});

	it("auto-rejects destructive actions", () => {
		const decision = checker.decide({
			actionId: "act_1",
			makerId: "maker_1",
			action: "credential:delete",
			target: "api_key",
			parameters: {},
			risk: "DESTRUCTIVE",
			rung: 4,
			timestamp: Date.now(),
			expiresAt: Date.now() + 60000,
		});

		expect(decision.decision).toBe(ACTION_STATUS.REJECTED);
	});

	it("auto-approves bounded actions", () => {
		const boundedDecision = checker.decide({
			actionId: "act_1",
			makerId: "maker_1",
			action: "shell:run",
			target: "npm install",
			parameters: {},
			risk: "BOUNDED",
			rung: 2,
			timestamp: Date.now(),
			expiresAt: Date.now() + 60000,
		});

		expect(boundedDecision.decision).toBe(ACTION_STATUS.APPROVED);
	});

	it("escalates risky actions to human", () => {
		const riskyDecision = checker.decide({
			actionId: "act_2",
			makerId: "maker_1",
			action: "git:push",
			target: "origin",
			parameters: {},
			risk: "RISKY",
			rung: 3,
			timestamp: Date.now(),
			expiresAt: Date.now() + 60000,
		});

		expect(riskyDecision.decision).toBe(ACTION_STATUS.PENDING);
	});
});

describe("Integration", () => {
	it("full maker-checker flow", () => {
		const store = new MakerCheckerStore();
		const checker = new AutomaticChecker();

		// Maker submits action
		const submit = store.submitAction(
			"vessel_001",
			"shell:run:npm",
			"npm test",
			{ flags: ["--coverage"] },
			"BOUNDED",
			4,
		);

		expect(submit.requiresChecker).toBe(true);
		expect(submit.rule?.checkerMode).toBe(CHECKER_MODE.AUTOMATIC);

		// Automatic checker decides
		const pending = store.getPending()[0];
		const autoDecision = checker.decide(pending);

		if (autoDecision.decision === ACTION_STATUS.APPROVED) {
			store.approve(submit.actionId!, "auto_checker", CHECKER_MODE.AUTOMATIC, autoDecision.reason);
		} else if (autoDecision.decision === ACTION_STATUS.REJECTED) {
			store.reject(submit.actionId!, "auto_checker", CHECKER_MODE.AUTOMATIC, autoDecision.reason);
		}

		const finalDecision = store.getDecision(submit.actionId!);
		expect(finalDecision?.status).toBe(ACTION_STATUS.APPROVED);
	});
});