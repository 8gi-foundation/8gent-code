/**
 * Tests for the harness-side text-protocol tool-calling module.
 *
 * Written test-first. Covers prompt rendering, tolerant parsing of fenced
 * tool_call blocks, and stripping blocks to recover the assistant prose.
 */

import { test, expect, describe } from "bun:test";
import {
	buildToolSystemPrompt,
	findUnterminatedToolCall,
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

	test("renders each tool's parameters compactly with name and type", () => {
		const prompt = buildToolSystemPrompt(TOOLS);
		// Compact signature form: name(param: type, ...). read_file takes a
		// required string `path`; the param name and its type must both appear,
		// without the pretty-printed JSON-schema noise.
		expect(prompt).toContain("read_file(");
		expect(prompt).toContain("path: string");
		// The verbose JSON-schema scaffolding is gone now that rendering is lean.
		expect(prompt).not.toContain('"properties"');
		expect(prompt).not.toContain("(JSON schema)");
	});

	test("marks optional parameters with a trailing ? and required ones plainly", () => {
		const prompt = buildToolSystemPrompt(TOOLS);
		// read_file.path is required -> `path: string` (no ?).
		expect(prompt).toContain("read_file(path: string)");
		// list_dir.path is not in `required` -> `path?: string`.
		expect(prompt).toContain("list_dir(path?: string)");
	});

	test("steers writes toward write_file and forbids fabricated success", () => {
		const prompt = buildToolSystemPrompt(TOOLS);
		// Bug B steering: file writes must go through write_file, never shell.
		expect(prompt).toContain("write_file");
		// Steering forbids using run_command to write files (text may wrap, so
		// normalize whitespace before matching).
		const flat = prompt.toLowerCase().replace(/\s+/g, " ");
		expect(flat).toContain("you must use the write_file tool");
		expect(flat).toContain("do not use run_command");
		// Never claim an action without the matching tool_call + result.
		expect(flat).toContain("never claim");
	});

	test("renders a realistic toolset well under a sane char budget", () => {
		// A ~10-tool set must stay lean enough to fit an 8k local window with
		// room for the conversation and tool results. The old pretty-printed
		// full-JSON-schema rendering blew well past this.
		const many: ToolSpec[] = Array.from({ length: 10 }, (_, i) => ({
			name: `tool_${i}`,
			description: `Performs operation number ${i} on the workspace and returns a result.`,
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
					recursive: { type: "boolean" },
				},
				required: ["path"],
			},
		}));
		const prompt = buildToolSystemPrompt(many);
		expect(prompt.length).toBeLessThan(6000);
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

// Same shape as the write_file payload from the 2026-09-28 Rishi pilot turn
// (ollama qwen3.8:27b-mlx): a multi-line Markdown outline with em dashes,
// backticks, arrows and braces inside the string value.
const OUTLINE = [
	"# Eight System One \u2014 Deck Outline (5 slides)",
	"",
	"## Slide 1 \u2014 What is Eight System One?",
	"- The harness asks typed questions about a `state` string",
	"- Request/response shape: `{ state, questions[] }` -> `{ answers[] }`",
	"",
	"## Slide 2 \u2014 Backends",
	"- `detectBackend()` tries llamacpp -> laya -> ollama",
	"\tindented with a tab",
].join("\n");

describe("parseToolCalls - real local-model output", () => {
	test("parses a properly escaped multi-line write_file call", () => {
		const text = [
			"```tool_call",
			JSON.stringify({ name: "write_file", arguments: { path: "deck/outline.md", content: OUTLINE } }),
			"```",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments.content).toBe(OUTLINE);
	});

	test("parses a write_file call whose content has RAW newlines and tabs inside the string", () => {
		// Local models often emit the string value with literal line breaks
		// instead of \n escapes. Strict JSON.parse rejects that, and the call
		// used to be dropped silently.
		const rawBody = `{"name": "write_file", "arguments": {"path": "deck/outline.md", "content": "${OUTLINE.replace(/"/g, '\\"')}"}}`;
		expect(() => JSON.parse(rawBody)).toThrow();
		const text = ["```tool_call", rawBody, "```"].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_file");
		expect(calls[0].arguments.content).toBe(OUTLINE);
	});

	test("raw control-character repair does not touch structure outside strings", () => {
		const text = [
			"```tool_call",
			"{",
			'\t"name": "write_file",',
			'\t"arguments": {"path": "a.md", "content": "line one',
			"line two with } and ``` inside",
			'last"}',
			"}",
			"```",
		].join("\n");
		const calls = parseToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toEqual({
			path: "a.md",
			content: "line one\nline two with } and ``` inside\nlast",
		});
	});

	test("still rejects genuinely malformed JSON (repair is not a free-for-all)", () => {
		const text = ["```tool_call", '{"name": "write_file", "arguments": {path: nope}}', "```"].join("\n");
		expect(parseToolCalls(text)).toEqual([]);
	});
});

describe("findUnterminatedToolCall", () => {
	test("reports a block cut off mid-string (output token limit)", () => {
		const full = JSON.stringify({ name: "write_file", arguments: { path: "deck/outline.md", content: OUTLINE } });
		const text = ["```tool_call", full.slice(0, Math.floor(full.length / 2))].join("\n");
		expect(parseToolCalls(text)).toEqual([]);
		expect(findUnterminatedToolCall(text)).toEqual({ name: "write_file", fenceStart: 0 });
	});

	test("returns null for complete calls and plain prose", () => {
		const ok = ["```tool_call", '{"name": "list_dir", "arguments": {"path": "."}}', "```"].join("\n");
		expect(findUnterminatedToolCall(ok)).toBeNull();
		expect(findUnterminatedToolCall("Just prose, no tools.")).toBeNull();
		expect(findUnterminatedToolCall("")).toBeNull();
	});

	test("reports a nameless cut-off block with name null", () => {
		expect(findUnterminatedToolCall('Writing it now.\n```tool_call\n{"na')).toEqual({ name: null, fenceStart: 16 });
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
