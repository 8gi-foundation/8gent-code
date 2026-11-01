import { describe, expect, test } from "bun:test";
import type { TextToolMessage } from "./text-tool-client";
import { type TextTool, runTextToolAgent } from "./text-tool-loop";

const TOOL_CALL = [
	"Reading it.",
	"```tool_call",
	'{"name": "read_file", "arguments": {"path": "a.txt"}}',
	"```",
].join("\n");

describe("runTextToolAgent steering (D1)", () => {
	test("a message sent while a tool runs lands after its result, before the next model call", async () => {
		const queue: string[] = [];
		const tool: TextTool = {
			spec: {
				name: "read_file",
				description: "Read",
				parameters: { type: "object", properties: {} },
			},
			run: async () => {
				// The person types while the tool is running.
				queue.push("use b.txt instead");
				return "contents of a";
			},
		};
		const seen: TextToolMessage[][] = [];
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read a.txt" }],
			tools: [tool],
			call: async (msgs) => {
				seen.push(msgs);
				return seen.length === 1 ? TOOL_CALL : "DONE: switched to b.txt";
			},
			steer: () => queue.splice(0),
		});

		// The first call never sees the steer: it did not exist yet.
		expect(seen[0].some((m) => m.content === "use b.txt instead")).toBe(false);
		// The second call sees it as the last message, after the tool result.
		const second = seen[1];
		expect(second[second.length - 1]).toEqual({ role: "user", content: "use b.txt instead" });
		expect(second[second.length - 2].content).toContain("contents of a");
		// It stays in the conversation for later rounds, exactly once.
		for (const msgs of seen.slice(2)) {
			expect(msgs.filter((m) => m.content === "use b.txt instead")).toHaveLength(1);
		}
		expect(queue).toHaveLength(0);
		expect(result.content).toContain("switched to b.txt");
	});

	test("no steer function or an empty queue leaves the conversation unchanged", async () => {
		const tool: TextTool = {
			spec: {
				name: "read_file",
				description: "Read",
				parameters: { type: "object", properties: {} },
			},
			run: async () => "contents",
		};
		const run = async (steer?: () => string[]) => {
			const seen: TextToolMessage[][] = [];
			await runTextToolAgent({
				messages: [{ role: "user", content: "read" }],
				tools: [tool],
				call: async (msgs) => {
					seen.push(msgs);
					return seen.length === 1 ? TOOL_CALL : "DONE: ok";
				},
				steer,
			});
			return seen;
		};
		expect(await run(() => [])).toEqual(await run());
	});
});
