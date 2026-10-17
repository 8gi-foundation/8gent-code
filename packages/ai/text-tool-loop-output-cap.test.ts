import { describe, expect, test } from "bun:test";
import { OutputCapError, type TextToolMessage } from "./text-tool-client";
import { MAX_OUTPUT_CAP_RETRIES, runTextToolAgent } from "./text-tool-loop";

const CAP = "ollama/m hit the 8192-token output cap without finishing its reply";
const input = { messages: [{ role: "user" as const, content: "do it" }], tools: [] };

describe("runTextToolAgent output cap", () => {
	test("a step cut at the output cap is retried with a one-file-per-call nudge", async () => {
		const seen: TextToolMessage[][] = [];
		const result = await runTextToolAgent({
			...input,
			call: async (msgs) => {
				seen.push(msgs);
				if (seen.length === 1) throw new OutputCapError(CAP);
				return "DONE: finished";
			},
		});
		expect(seen.length).toBe(2);
		expect(seen[1].at(-1)?.content).toContain("one file per tool_call");
		expect(result.content).toContain("finished");
	});

	test("after the retry budget the cap error still surfaces", async () => {
		let calls = 0;
		await expect(
			runTextToolAgent({
				...input,
				call: async () => {
					calls++;
					throw new OutputCapError(CAP);
				},
			}),
		).rejects.toThrow("output cap");
		expect(calls).toBe(MAX_OUTPUT_CAP_RETRIES + 1);
	});

	test("other errors are not retried", async () => {
		let calls = 0;
		await expect(
			runTextToolAgent({
				...input,
				call: async () => {
					calls++;
					throw new Error("connection refused");
				},
			}),
		).rejects.toThrow("connection refused");
		expect(calls).toBe(1);
	});
});
