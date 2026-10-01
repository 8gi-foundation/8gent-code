/**
 * #3268: CompactionEngine.findCutPoint on a history shorter than keepRecentTokens.
 *
 * cutIdx used to start at messages.length. When the walk back from the newest
 * message never accumulated keepRecentTokens (20,000 by default), it stayed
 * there and the pair checks read messages[messages.length].role, a TypeError.
 * The agent caught it as "[COMPRESSION] Failed", so the simplify stage never
 * ran for any model with a context window under roughly 25k tokens.
 *
 * A short history now means "nothing to compact": no summary call, history
 * unchanged. Long histories cut exactly where they did before.
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { CompactionEngine, ProactiveCompression } from "../compaction";

type Msg = { role: string; content: string };

/** content of n*4 - 16 chars costs exactly n tokens (ceil(len/4) + 4 per message). */
function sized(role: string, tokens: number, tag = ""): Msg {
	const body = "x".repeat(tokens * 4 - 16 - tag.length);
	return { role, content: tag + body };
}

/** system prompt + n alternating user/assistant messages, each `tokens` tokens. */
function history(n: number, tokens: number): Msg[] {
	const msgs: Msg[] = [{ role: "system", content: "You are Eight." }];
	for (let i = 1; i <= n; i++)
		msgs.push(sized(i % 2 === 1 ? "user" : "assistant", tokens, `m${i} `));
	return msgs;
}

function fakeModel() {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			content: [{ type: "text", text: "SUMMARY_3268" }],
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
			warnings: [],
		}),
	} as ConstructorParameters<typeof MockLanguageModelV3>[0]);
}

function cutPoint(engine: CompactionEngine, msgs: Msg[]): number {
	return (engine as unknown as { findCutPoint(m: Msg[]): number }).findCutPoint(msgs);
}

describe("findCutPoint: short history (#3268)", () => {
	test("a history far under keepRecentTokens returns no cut instead of throwing", () => {
		const engine = new CompactionEngine();
		expect(cutPoint(engine, history(4, 100))).toBe(1);
	});

	test("a history one token under keepRecentTokens returns no cut", () => {
		const engine = new CompactionEngine();
		// 19 x 1000 + 999 = 19,999 tokens after the system prompt; default keep is 20,000.
		const msgs = history(19, 1000);
		msgs.push(sized("assistant", 999));
		expect(cutPoint(engine, msgs)).toBe(1);
	});

	test("compact() on a short history makes no summary call and keeps every message", async () => {
		const engine = new CompactionEngine();
		const model = fakeModel();
		const msgs = history(4, 100);
		const { messages, result } = await engine.compact(msgs, model);
		expect(messages).toEqual(msgs);
		expect(result.messagesRemoved).toBe(0);
		expect(result.tokensAfter).toBe(result.tokensBefore);
		expect(model.doGenerateCalls.length).toBe(0);
	});

	test("the simplify stage on a small-window model thins the history instead of failing", async () => {
		const engine = new ProactiveCompression();
		const model = fakeModel();
		// 8k window, ~7.5k tokens used: ratio ~0.94 is the simplify stage.
		const msgs = history(10, 750);
		expect(engine.getStage(msgs, 8000)).toBe("simplify");
		const { messages, result } = await engine.compactProactive(msgs, model, 8000);
		expect(result.stage).toBe("simplify");
		expect(messages.length).toBe(msgs.length);
		expect(messages[1].content.endsWith("...[truncated]")).toBe(true);
		const chars = (m: Msg[]) => m.reduce((n, x) => n + x.content.length, 0);
		expect(chars(messages)).toBeLessThan(chars(msgs));
		expect(result.messagesRemoved).toBe(0);
		expect(model.doGenerateCalls.length).toBe(0);
	});
});

describe("findCutPoint: long history cuts as before (#3268)", () => {
	test("a history just over keepRecentTokens cuts where the 20,000-token window starts", () => {
		const engine = new CompactionEngine();
		// 22 x 1000 tokens. Walking back, the 20th message from the end (index 3,
		// a user turn) brings the total to 20,000, so the cut is 3.
		expect(cutPoint(engine, history(22, 1000))).toBe(3);
	});

	test("a cut that lands on an assistant reply moves back to keep its user turn", () => {
		const engine = new CompactionEngine();
		// 23 messages: the 20,000 mark is index 4 (assistant), paired with user 3.
		expect(cutPoint(engine, history(23, 1000))).toBe(3);
	});

	test("a cut that lands on a tool result moves back to keep its call", () => {
		const engine = new CompactionEngine();
		// 23 messages: the 20,000 mark is index 4, here a tool result for call 3.
		const msgs = history(23, 1000);
		msgs[3] = sized("assistant", 1000);
		msgs[4] = sized("tool", 1000);
		expect(cutPoint(engine, msgs)).toBe(3);
	});

	test("a history that reaches keepRecentTokens at the first message keeps everything", () => {
		const engine = new CompactionEngine();
		expect(cutPoint(engine, history(20, 1000))).toBe(1);
	});

	test("compact() on a long history summarises the older messages once", async () => {
		const engine = new CompactionEngine();
		const model = fakeModel();
		const msgs = history(22, 1000);
		const { messages, result } = await engine.compact(msgs, model);
		expect(result.messagesRemoved).toBe(2);
		expect(model.doGenerateCalls.length).toBe(1);
		// system + summary + the 20 kept messages, in order.
		expect(messages.length).toBe(22);
		expect(messages[0]).toEqual(msgs[0]);
		expect(messages.slice(2)).toEqual(msgs.slice(3));
		expect(messages[1].content).toContain("SUMMARY_3268");
	});
});
