/**
 * TwoStageCompactor — acceptance criteria for two-stage context compaction.
 *
 * Concept extracted from StartupHakk/OpenMonoAgent under CleanRoomPort rules;
 * no AGPL source copied. Tests are written from issue #2467 acceptance criteria,
 * not from any external implementation.
 *
 * Determinism: mocked summarizer + explicit token estimator, no real LLM,
 * no clock dependency (the compactor is purely state-driven).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	type AgentState,
	type Summarizer,
	TwoStageCompactor,
} from "../two-stage-compactor";

// 4 chars per token (matches existing estimateTokens in compaction.ts).
const CHARS_PER_TOKEN = 4;

function tokensToChars(tokens: number): number {
	return tokens * CHARS_PER_TOKEN;
}

function makeMessage(role: string, tokens: number, tag = "x"): {
	role: string;
	content: string;
} {
	// Each message also has a +4 token overhead in the estimator, so subtract 1
	// token of padding from the content to land on the requested total cleanly
	// in tests that care about exact percentages.
	const charCount = Math.max(1, tokensToChars(Math.max(1, tokens - 4)));
	return { role, content: tag.repeat(charCount) };
}

function makeState(opts: {
	contextSize: number;
	usedTokens: number;
	tailMessages?: number;
}): AgentState {
	const tail = opts.tailMessages ?? 6;
	const tailBudget = Math.min(opts.usedTokens, tail * 50);
	const olderBudget = Math.max(0, opts.usedTokens - tailBudget);

	const messages: { role: string; content: string }[] = [
		{ role: "system", content: "sys" },
	];

	// One large "older" message carrying the bulk of tokens.
	if (olderBudget > 8) {
		messages.push(makeMessage("user", olderBudget, "o"));
	}

	// Tail messages, each ~50 tokens.
	for (let i = 0; i < tail; i++) {
		const role = i % 2 === 0 ? "user" : "assistant";
		messages.push(makeMessage(role, 50, "t"));
	}

	return {
		messages,
		checkpoints: [],
		provider: { contextSize: opts.contextSize },
	};
}

function mockSummarizer(label = "SUMMARY"): Summarizer {
	let n = 0;
	const fn: Summarizer = async (msgs) => {
		n++;
		return `${label}#${n}(msgs=${msgs.length})`;
	};
	return fn;
}

describe("TwoStageCompactor — acceptance criteria for #2467", () => {
	let summarizer: Summarizer;

	beforeEach(() => {
		summarizer = mockSummarizer();
	});

	it("AC1: at 60% context returns action 'none'", async () => {
		const ctx = 32_000;
		const state = makeState({ contextSize: ctx, usedTokens: Math.floor(ctx * 0.6) });
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN: 4,
			summarizer,
		});
		const result = await compactor.observe(state);
		expect(result.action).toBe("none");
		expect(state.checkpoints.length).toBe(0);
	});

	it("AC2: at 65% context returns 'checkpoint', message list unchanged, 1 checkpoint stored", async () => {
		const ctx = 32_000;
		const state = makeState({ contextSize: ctx, usedTokens: Math.floor(ctx * 0.66) });
		const before = state.messages.length;
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN: 4,
			summarizer,
		});
		const result = await compactor.observe(state);
		expect(result.action).toBe("checkpoint");
		expect(state.messages.length).toBe(before);
		expect(state.checkpoints.length).toBe(1);
		expect(state.checkpoints[0].summary).toContain("SUMMARY");
		expect(state.checkpoints[0].cutoffIndex).toBeGreaterThan(0);
	});

	it("AC3: at 80% context returns 'compact', messages reduced to (1 summary + keepLastN tail)", async () => {
		const ctx = 32_000;
		const keepLastN = 4;
		const state = makeState({
			contextSize: ctx,
			usedTokens: Math.floor(ctx * 0.82),
			tailMessages: 8,
		});
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN,
			summarizer,
		});
		const result = await compactor.observe(state);
		expect(result.action).toBe("compact");
		// 1 system + 1 summary + keepLastN tail
		expect(state.messages.length).toBe(2 + keepLastN);
		expect(state.messages[1].role).toBe("system");
		expect(state.messages[1].content).toContain("SUMMARY");
	});

	it("AC4: successive checkpoint calls don't duplicate (one per crossing of 65%)", async () => {
		const ctx = 32_000;
		const state = makeState({ contextSize: ctx, usedTokens: Math.floor(ctx * 0.66) });
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN: 4,
			summarizer,
		});
		const r1 = await compactor.observe(state);
		const r2 = await compactor.observe(state);
		const r3 = await compactor.observe(state);
		expect(r1.action).toBe("checkpoint");
		expect(r2.action).toBe("none");
		expect(r3.action).toBe("none");
		expect(state.checkpoints.length).toBe(1);
	});

	it("AC5: after 'compact', token usage drops below 50% of context", async () => {
		const ctx = 32_000;
		const keepLastN = 4;
		const state = makeState({
			contextSize: ctx,
			usedTokens: Math.floor(ctx * 0.85),
			tailMessages: 6,
		});
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN,
			summarizer,
		});
		const result = await compactor.observe(state);
		expect(result.action).toBe("compact");
		const tokensAfter = result.report?.tokensAfter ?? Number.POSITIVE_INFINITY;
		const ratio = tokensAfter / ctx;
		expect(ratio).toBeLessThan(0.5);
	});

	it("AC6: provider context size respected (32K provider triggers near 21K and 26K)", async () => {
		const ctx = 32_000;
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN: 4,
			summarizer,
		});

		// Just below 65% of 32K (~20.4K) should be 'none'.
		const lowState = makeState({ contextSize: ctx, usedTokens: 20_000 });
		expect((await compactor.observe(lowState)).action).toBe("none");

		// Around 22K (~68%) should checkpoint.
		const midState = makeState({ contextSize: ctx, usedTokens: 22_000 });
		expect((await compactor.observe(midState)).action).toBe("checkpoint");

		// Around 27K (~84%) should compact.
		const hiCompactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN: 4,
			summarizer: mockSummarizer(),
		});
		const hiState = makeState({
			contextSize: ctx,
			usedTokens: 27_000,
			tailMessages: 6,
		});
		expect((await hiCompactor.observe(hiState)).action).toBe("compact");
	});

	it("AC7: back-compat — single-stage degenerate config (checkpointPct === compactPct) skips checkpoint stage", async () => {
		const ctx = 32_000;
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.8,
			compactPct: 0.8,
			keepLastN: 4,
			summarizer,
		});

		// At 70%: below the single threshold, no action.
		const underState = makeState({ contextSize: ctx, usedTokens: Math.floor(ctx * 0.7) });
		expect((await compactor.observe(underState)).action).toBe("none");

		// At 82%: crosses single threshold, jumps straight to compact.
		const overState = makeState({
			contextSize: ctx,
			usedTokens: Math.floor(ctx * 0.82),
			tailMessages: 6,
		});
		const result = await compactor.observe(overState);
		expect(result.action).toBe("compact");
		expect(overState.checkpoints.length).toBeGreaterThanOrEqual(1);
	});

	it("checkpoint then compact: the compact action consumes the existing checkpoint summary", async () => {
		const ctx = 32_000;
		const keepLastN = 4;
		const state = makeState({
			contextSize: ctx,
			usedTokens: Math.floor(ctx * 0.7),
			tailMessages: 6,
		});
		const compactor = new TwoStageCompactor({
			checkpointPct: 0.65,
			compactPct: 0.8,
			keepLastN,
			summarizer,
		});

		const r1 = await compactor.observe(state);
		expect(r1.action).toBe("checkpoint");
		expect(state.checkpoints.length).toBe(1);

		// Bloat the older message so usage now crosses 80%.
		state.messages[1] = makeMessage("user", Math.floor(ctx * 0.85), "B");
		const r2 = await compactor.observe(state);
		expect(r2.action).toBe("compact");
		expect(state.messages[1].role).toBe("system");
		expect(state.messages[1].content).toContain("SUMMARY");
	});
});
