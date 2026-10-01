/**
 * Terminus-2 summarize stage must never keep a tail that opens on a tool
 * result whose assistant tool_call was summarized away. Strict
 * OpenAI-compatible servers reject such a history with a 400.
 */
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { ProactiveCompression } from "../compaction";

type Msg = {
	role: string;
	content: string;
	toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
	toolCallId?: string;
};

function mockModel() {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			content: [{ type: "text", text: "summary" }],
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
			warnings: [],
		}),
	});
}

const pad = "x".repeat(800);

function assistantCalling(ids: string[]): Msg {
	return {
		role: "assistant",
		content: `calling ${ids.join(",")} ${pad}`,
		toolCalls: ids.map((id) => ({ id, name: "read_file", arguments: { path: `${id}.ts` } })),
	};
}

function toolResult(id: string): Msg {
	return { role: "tool", content: `result ${id} ${pad}`, toolCallId: id };
}

/** Context window that puts the history in the "summarize" band (0.8 to 0.9). */
function summarizeWindow(messages: Msg[]): number {
	const used = messages.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0);
	return Math.floor(used / 0.85);
}

/** Every tool message in `tail` must answer a tool_call of an earlier assistant in `tail`. */
function assertToolCallsPaired(tail: Msg[]) {
	const issued = new Set<string>();
	for (const m of tail) {
		if (m.role === "assistant") for (const c of m.toolCalls ?? []) issued.add(c.id);
		if (m.role === "tool") expect(issued.has(m.toolCallId as string)).toBe(true);
	}
}

async function runSummarize(history: Msg[]) {
	const engine = new ProactiveCompression();
	const cw = summarizeWindow(history);
	expect(engine.getStage(history, cw)).toBe("summarize");
	const { messages, result } = await engine.compactProactive(history, mockModel(), cw);
	expect(result.stage).toBe("summarize");
	return messages as Msg[];
}

describe("Terminus-2 kept tail respects tool_call boundaries", () => {
	test("last-8 cut landing on a single tool result moves back to its assistant", async () => {
		const history: Msg[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: `u1 ${pad}` },
			{ role: "assistant", content: `a1 ${pad}` },
			{ role: "user", content: `u2 ${pad}` },
			assistantCalling(["t1"]),
			toolResult("t1"), // index 5 = length - 8: the naive cut lands here
			{ role: "assistant", content: `a3 ${pad}` },
			{ role: "user", content: `u3 ${pad}` },
			assistantCalling(["t2"]),
			toolResult("t2"),
			{ role: "assistant", content: `a5 ${pad}` },
			{ role: "user", content: `u4 ${pad}` },
			{ role: "assistant", content: `a6 ${pad}` },
		];
		expect(history[history.length - 8].role).toBe("tool");

		const out = await runSummarize(history);
		expect(out[0].content).toBe("sys");
		expect(out[1].content).toContain("[Proactive Compression: Terminus-2]");
		const tail = out.slice(2);
		expect(tail[0].role).not.toBe("tool");
		assertToolCallsPaired(tail);
		expect(tail.some((m) => m.toolCallId === "t1")).toBe(true);
	});

	test("cut landing mid-way through parallel tool results walks back past all of them", async () => {
		const history: Msg[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: `u1 ${pad}` },
			{ role: "assistant", content: `a1 ${pad}` },
			{ role: "user", content: `u2 ${pad}` },
			assistantCalling(["p1", "p2", "p3"]),
			toolResult("p1"),
			toolResult("p2"), // index 6 = length - 8
			toolResult("p3"),
			{ role: "assistant", content: `a3 ${pad}` },
			{ role: "user", content: `u3 ${pad}` },
			{ role: "assistant", content: `a4 ${pad}` },
			{ role: "user", content: `u4 ${pad}` },
			{ role: "assistant", content: `a5 ${pad}` },
			{ role: "user", content: `u5 ${pad}` },
		];
		expect(history[history.length - 8].role).toBe("tool");

		const out = await runSummarize(history);
		const tail = out.slice(2);
		expect(tail[0].role).toBe("assistant");
		expect(tail[0].toolCalls?.map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
		assertToolCallsPaired(tail);
	});

	test("short history never duplicates the system prompt into the tail", async () => {
		const history: Msg[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: `u1 ${pad}` },
			assistantCalling(["s1"]),
			toolResult("s1"),
			{ role: "assistant", content: `a2 ${pad}` },
		];
		const out = await runSummarize(history);
		expect(out.filter((m) => m.content === "sys")).toHaveLength(1);
		assertToolCallsPaired(out.slice(2));
	});
});
