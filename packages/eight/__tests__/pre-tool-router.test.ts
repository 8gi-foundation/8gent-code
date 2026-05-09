/**
 * PreToolRouter — deterministic harness routing tests.
 *
 * Each test maps an acceptance criterion from issue #2471 to a single
 * router decision. The router is deterministic (no LLM) and model-agnostic.
 *
 * Concept extracted under CleanRoomPort rules; no external source copied.
 */

import { describe, expect, it } from "bun:test";
import { PreToolRouter, type ProjectContext } from "../pre-tool-router";

const baseCtx: ProjectContext = {
	cwd: "/tmp/proj",
	knownFiles: [
		"src/components/message-list.tsx",
		"packages/eight/agent.ts",
	],
};

function makeRouter(opts: { ast?: boolean; vector?: boolean } = {}) {
	return new PreToolRouter({
		astAvailable: opts.ast ?? true,
		vectorAvailable: opts.vector ?? true,
	});
}

describe("PreToolRouter — acceptance criteria", () => {
	it("AC1: 'how does parseSkillCommand work' → ast with symbol arg", () => {
		const router = makeRouter();
		const decision = router.classify(
			"how does parseSkillCommand work",
			baseCtx,
		);
		expect(decision.strategy).toBe("ast");
		expect(decision.args.symbol).toBe("parseSkillCommand");
		expect(decision.confidence).toBeGreaterThan(0.6);
	});

	it("AC2: 'find all uses of \"TODO:\"' → grep with literal pattern", () => {
		const router = makeRouter();
		const decision = router.classify(
			'find all uses of "TODO:"',
			baseCtx,
		);
		expect(decision.strategy).toBe("grep");
		expect(decision.args.pattern).toBe("TODO:");
		expect(decision.confidence).toBeGreaterThan(0.6);
	});

	it("AC3: 'list all *.tsx files' → glob with pattern", () => {
		const router = makeRouter();
		const decision = router.classify("list all *.tsx files", baseCtx);
		expect(decision.strategy).toBe("glob");
		expect(decision.args.pattern).toBe("*.tsx");
		expect(decision.confidence).toBeGreaterThan(0.6);
	});

	it("AC4: 'what is the BDH thesis' → vector with concept-no-symbol reason", () => {
		const router = makeRouter();
		const decision = router.classify("what is the BDH thesis", baseCtx);
		expect(decision.strategy).toBe("vector");
		expect(decision.reason.toLowerCase()).toContain("concept");
		expect(decision.reason.toLowerCase()).toContain("symbol");
		expect(decision.confidence).toBeGreaterThan(0.6);
	});

	it("AC5: 'open src/components/message-list.tsx' → fileread with path", () => {
		const router = makeRouter();
		const decision = router.classify(
			"open src/components/message-list.tsx",
			baseCtx,
		);
		expect(decision.strategy).toBe("fileread");
		expect(decision.args.path).toBe("src/components/message-list.tsx");
		expect(decision.confidence).toBeGreaterThan(0.6);
	});

	it("AC6: 'hey' → none, low confidence", () => {
		const router = makeRouter();
		const decision = router.classify("hey", baseCtx);
		expect(decision.strategy).toBe("none");
		expect(decision.confidence).toBeLessThan(0.3);
	});

	it("AC7: ast unavailable → falls back to grep, never returns ast", () => {
		const router = makeRouter({ ast: false });
		const decision = router.classify(
			"how does parseSkillCommand work",
			baseCtx,
		);
		expect(decision.strategy).not.toBe("ast");
		expect(decision.strategy).toBe("grep");
		expect(decision.args.pattern).toBe("parseSkillCommand");
	});

	it("AC8 (helper): formatPreFetchedContext produces a system-message body", async () => {
		const { formatPreFetchedContext } = await import("../pre-tool-router");
		const body = formatPreFetchedContext(
			{
				strategy: "grep",
				args: { pattern: "TODO:" },
				confidence: 0.8,
				reason: "literal in quotes",
			},
			"src/foo.ts:42:// TODO: refactor",
		);
		expect(body).toContain("PRE-FETCHED CONTEXT");
		expect(body).toContain("grep");
		expect(body).toContain("TODO:");
		expect(body).toContain("// TODO: refactor");
	});
});

describe("PreToolRouter — additional coverage", () => {
	it("vector unavailable + concept question → falls back to grep on key term", () => {
		const router = makeRouter({ vector: false });
		const decision = router.classify("what is the BDH thesis", baseCtx);
		expect(decision.strategy).toBe("grep");
	});

	it("snake_case symbol → ast", () => {
		const router = makeRouter();
		const decision = router.classify("explain parse_skill_command", baseCtx);
		expect(decision.strategy).toBe("ast");
		expect(decision.args.symbol).toBe("parse_skill_command");
	});

	it("glob pattern with src/** → glob", () => {
		const router = makeRouter();
		const decision = router.classify("show me src/**/*.ts", baseCtx);
		expect(decision.strategy).toBe("glob");
		expect(String(decision.args.pattern)).toContain("src/**");
	});

	it("file path with extension that does not look like a glob → fileread", () => {
		const router = makeRouter();
		const decision = router.classify(
			"please look at packages/eight/agent.ts for me",
			baseCtx,
		);
		expect(decision.strategy).toBe("fileread");
		expect(decision.args.path).toBe("packages/eight/agent.ts");
	});

	it("greeting with punctuation → none", () => {
		const router = makeRouter();
		const decision = router.classify("hi there!", baseCtx);
		expect(decision.strategy).toBe("none");
		expect(decision.confidence).toBeLessThan(0.3);
	});

	it("grep beats glob when both literal AND glob present (literal wins for specificity)", () => {
		const router = makeRouter();
		// The literal in quotes is the strongest signal; pattern follows.
		const decision = router.classify(
			'find "useEffect" in *.tsx files',
			baseCtx,
		);
		expect(decision.strategy).toBe("grep");
		expect(decision.args.pattern).toBe("useEffect");
	});
});
