/**
 * Tests for the harness-side text-protocol tool-calling module.
 *
 * Written test-first. Covers prompt rendering, tolerant parsing of fenced
 * tool_call blocks, and stripping blocks to recover the assistant prose.
 */

import { test, expect, describe } from "bun:test";
import {
	buildToolSystemPrompt,
	needsTextTools,
	parseToolCalls,
	stripToolCalls,
	type ToolSpec,
} from "./text-tools";

const TOOLS: ToolSpec[] = [
	{
		name: "read_file",
		description: "Read a file from disk and return its contents.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "list_dir",
		description: "List the entries in a directory.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
		},
	},
];

describe("buildToolSystemPrompt", () => {
	test("includes each tool name and the tool_call token", () => {
		const prompt = buildToolSystemPrompt(TOOLS);
		expect(prompt).toContain("read_file");
		expect(prompt).toContain("list_dir");
		expect(prompt).toContain("tool_call");
	});

	test("includes each tool's description", () => {
		const prompt = buildToolSystemPrompt(TOOLS);
		expect(prompt).toContain("Read a file from disk and return its contents.");
		expect(prompt).toContain("List the entries in a directory.");
	});

	test("renders the parameter schema for each tool", () => {
		const prompt = buildToolSystemPrompt(TOOLS);
		// The schema JSON for read_file's "required" array should appear.
		expect(prompt).toContain('"required"');
		expect(prompt).toContain('"properties"');
	});

	test("handles an empty tool list without throwing", () => {
		const prompt = buildToolSystemPrompt([]);
		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("tool_call");
	});
});

describe("parseToolCalls", () => {
	test("returns [] for plain prose with no blocks", () => {
		expect(parseToolCalls("Just a normal answer with no tool calls.")).toEqual([]);
	});

	test("parses exactly one call", () => {
		const text = [
			"Let me read that file.",
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "a.txt"}}',
			"```",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			name: "read_file",
			arguments: { path: "a.txt" },
		});
	});

	test("parses N (>=2) calls in one text", () => {
		const text = [
			"I will do two things.",
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "a.txt"}}',
			"```",
			"And then:",
			"```tool_call",
			'{"name": "list_dir", "arguments": {"path": "src"}}',
			"```",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe("read_file");
		expect(calls[1].name).toBe("list_dir");
		expect(calls[1].arguments).toEqual({ path: "src" });
	});

	test("skips a malformed-JSON block without throwing and keeps valid ones", () => {
		const text = [
			"```tool_call",
			"{ this is not valid json",
			"```",
			"some prose",
			"```tool_call",
			'{"name": "list_dir", "arguments": {"path": "."}}',
			"```",
		].join("\n");
		let calls: ReturnType<typeof parseToolCalls> = [];
		expect(() => {
			calls = parseToolCalls(text);
		}).not.toThrow();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("list_dir");
	});

	test("skips a block whose JSON lacks a string name", () => {
		const text = [
			"```tool_call",
			'{"arguments": {"path": "a.txt"}}',
			"```",
			"```tool_call",
			'{"name": 42, "arguments": {}}',
			"```",
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "ok.txt"}}',
			"```",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("read_file");
	});

	test("tolerates prose before, between, and after blocks", () => {
		const text = [
			"Intro prose here.",
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "a.txt"}}',
			"```",
			"Middle prose that explains the next step.",
			"```tool_call",
			'{"name": "list_dir", "arguments": {"path": "."}}',
			"```",
			"Trailing prose, the wrap-up.",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls.map((c) => c.name)).toEqual(["read_file", "list_dir"]);
	});

	test("defaults arguments to {} when absent", () => {
		const text = ["```tool_call", '{"name": "list_dir"}', "```"].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toEqual({});
	});

	test("preserves the arguments object exactly", () => {
		const args = {
			path: "deep/nested/file.ts",
			flags: ["a", "b"],
			opts: { recursive: true, depth: 3 },
			count: 0,
		};
		const text = [
			"```tool_call",
			JSON.stringify({ name: "read_file", arguments: args }),
			"```",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toEqual(args);
	});

	test("returns [] for empty string", () => {
		expect(parseToolCalls("")).toEqual([]);
	});

	test("parses a call whose arguments.content contains a fenced code block", () => {
		const content = "# Title\n```bash\nnpm i\n```\ndone";
		const text = [
			"I will write the readme.",
			"```tool_call",
			JSON.stringify({
				name: "write_file",
				arguments: { path: "README.md", content },
			}),
			"```",
			"Done.",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_file");
		expect(calls[0].arguments).toEqual({ path: "README.md", content });
	});

	test("parses correctly with CRLF line endings", () => {
		const text = [
			"prose before",
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "a.txt"}}',
			"```",
			"prose after",
		].join("\r\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			name: "read_file",
			arguments: { path: "a.txt" },
		});
	});

	test("handles a JSON string value containing a literal brace and an escaped quote", () => {
		// content has a `}` (which must not end the object early) and a `\"`
		// escape (the scanner must not treat the escaped quote as a delimiter).
		const content = 'function f() { return "a \\" b"; }';
		const text = [
			"```tool_call",
			JSON.stringify({ name: "write_file", arguments: { content } }),
			"```",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toEqual({ content });
	});

	test("parses a call when the trailing fence is absent", () => {
		const text = [
			"```tool_call",
			'{"name": "list_dir", "arguments": {"path": "."}}',
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("list_dir");
	});
});

describe("needsTextTools", () => {
	test("returns true when the provider lacks native tool support", () => {
		expect(needsTextTools({ supportsNativeTools: false })).toBe(true);
	});

	test("returns false when the provider supports native tools", () => {
		expect(needsTextTools({ supportsNativeTools: true })).toBe(false);
	});
});

describe("stripToolCalls", () => {
	test("removes blocks and keeps the prose, trimmed", () => {
		const text = [
			"Here is my plan.",
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "a.txt"}}',
			"```",
			"That is all.",
		].join("\n");
		const stripped = stripToolCalls(text);
		expect(stripped).toContain("Here is my plan.");
		expect(stripped).toContain("That is all.");
		expect(stripped).not.toContain("tool_call");
		expect(stripped).not.toContain("read_file");
		// No leading/trailing whitespace.
		expect(stripped).toBe(stripped.trim());
	});

	test("returns trimmed prose when there are no blocks", () => {
		expect(stripToolCalls("   only prose   ")).toBe("only prose");
	});

	test("returns empty string when the text is only a block", () => {
		const text = ["```tool_call", '{"name": "list_dir"}', "```"].join("\n");
		expect(stripToolCalls(text)).toBe("");
	});

	test("leaves clean prose when a block's args contain a fenced code block", () => {
		const content = "# Title\n```bash\nnpm i\n```\ndone";
		const text = [
			"I will write the readme.",
			"```tool_call",
			JSON.stringify({
				name: "write_file",
				arguments: { path: "README.md", content },
			}),
			"```",
			"Done.",
		].join("\n");
		const stripped = stripToolCalls(text);
		expect(stripped).toContain("I will write the readme.");
		expect(stripped).toContain("Done.");
		// No JSON shrapnel from the call survives.
		expect(stripped).not.toContain("write_file");
		expect(stripped).not.toContain("README.md");
		expect(stripped).not.toContain("npm i");
		expect(stripped).not.toContain("tool_call");
		expect(stripped).toBe(stripped.trim());
	});
});
