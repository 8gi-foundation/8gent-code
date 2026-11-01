/**
 * #5234: tool calls on the phone. A small local model served by llama.cpp writes
 * its call as <tool_call> text in these shapes; each used to run the tool with
 * empty arguments or not at all. The inputs are the reply text as the model wrote it.
 */
import { describe, expect, test } from "bun:test";
import { replyIsTextToolCall } from "../eight/text-call-fallback";
import { parseToolCalls, stripToolCalls } from "./text-tools";

const known = ["read_file", "run_command"];
const want = [{ name: "read_file", arguments: { path: "src/a.ts" } }];
const parse = (t: string) => parseToolCalls(t, { knownTools: known });

describe("small-model tool call shapes (#5234)", () => {
	test("arguments written as a JSON-encoded string keep their arguments", () => {
		const t =
			'<tool_call>\n{"name":"read_file","arguments":"{\\"path\\":\\"src/a.ts\\"}"}\n</tool_call>';
		expect(parse(t)).toEqual(want);
		expect(replyIsTextToolCall(t, 0, known)).toBe(true);
	});

	test("OpenAI function wrapper with string arguments", () => {
		const t =
			'<tool_call>\n{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/a.ts\\"}"}}\n</tool_call>';
		expect(parse(t)).toEqual(want);
	});

	test("tag on the same line as a short lead-in", () => {
		const t =
			'Let me check. <tool_call>{"name":"read_file","arguments":{"path":"src/a.ts"}}</tool_call>';
		expect(parse(t)).toEqual(want);
		expect(replyIsTextToolCall(t, 0, known)).toBe(true);
		expect(stripToolCalls(t, { knownTools: known })).toBe("Let me check.");
	});

	test("trailing comma before the closing brace", () => {
		const t = '<tool_call>\n{"name":"read_file","arguments":{"path":"src/a.ts",}}\n</tool_call>';
		expect(parse(t)).toEqual(want);
	});

	test("a comma inside a string value is left alone", () => {
		const t =
			'<tool_call>\n{"name":"run_command","arguments":{"command":"echo a,}",}}\n</tool_call>';
		expect(parse(t)).toEqual([{ name: "run_command", arguments: { command: "echo a,}" } }]);
	});

	test("prose that quotes the tag is still not a call", () => {
		expect(
			parse('Write it as `<tool_call>{"name":"read_file","arguments":{}}</tool_call>`.'),
		).toEqual([]);
		expect(parse('He said "<tool_call>{"name":"read_file","arguments":{}}</tool_call>"')).toEqual(
			[],
		);
	});

	test("an unknown tool name is still not a call", () => {
		expect(parse('ok <tool_call>{"name":"rm_rf","arguments":"{}"}</tool_call>')).toEqual([]);
	});
});
