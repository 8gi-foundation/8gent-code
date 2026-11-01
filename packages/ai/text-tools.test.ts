/**
 * Tests for the harness-side text-protocol tool-calling module.
 *
 * Written test-first. Covers prompt rendering, tolerant parsing of fenced
 * tool_call blocks, and stripping blocks to recover the assistant prose.
 */

import { test, expect, describe } from "bun:test";
import {
	buildToolSystemPrompt,
	escapeInvalidBackslashesInStrings,
	findUnterminatedToolCall,
	needsTextTools,
	parseToolCalls,
	stripToolCalls,
	type ToolSpec,
} from "./text-tools";
import { LLAMA32_BARE_JSON_REPLY } from "./text-tools.fixtures";

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

	// Ollama runs the model's built-in parser on every chat reply. Qwen's parser
	// hijacks anything after a literal <tool_call>, so when the prompt spelled
	// the tag out ("do NOT use <tool_call>"), a model that quoted or reasoned
	// about that rule had its reply eaten: 3 of 3 live replies came back empty
	// on qwen3.8:27b-mlx, 3 of 3 intact once the literals were gone (2026-09-29).
	test("never spells out a native tool-call marker that a server-side parser hijacks", () => {
		for (const prompt of [buildToolSystemPrompt(TOOLS), buildToolSystemPrompt([])]) {
			for (const marker of ["<tool_call>", "</tool_call>", "<|tool_call|>", "<function="]) {
				expect(prompt).not.toContain(marker);
			}
		}
	});

	test("still forbids native markup in words and keeps the fenced format", () => {
		const prompt = buildToolSystemPrompt(TOOLS);
		expect(prompt).toContain("```tool_call");
		expect(prompt).toMatch(/do NOT use angle brackets/);
		expect(prompt).toMatch(/built-in tool-call tags or special tokens/);
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

const REGISTERED = ["read_file", "write_file", "get_outline", "run_command"];

describe("parseToolCalls - bare / ```json calls from small local models", () => {
	test("parses the exact llama3.2:3b reply as two calls, in order", () => {
		const calls = parseToolCalls(LLAMA32_BARE_JSON_REPLY, { knownTools: REGISTERED });
		expect(calls.map((c) => c.name)).toEqual(["get_outline", "write_file"]);
		expect(calls[0].arguments).toEqual({ path: "deck/outline.md" });
		const content = String(calls[1].arguments.content);
		expect(content.startsWith("---\nmarp: true\n")).toBe(true);
		expect(content.match(/^## /gm)?.length).toBe(6);
		expect(String(calls[1].arguments.path).endsWith("/project/deck/deck.md")).toBe(true);
	});

	test("strips the exact llama3.2:3b reply down to no prose", () => {
		expect(stripToolCalls(LLAMA32_BARE_JSON_REPLY, { knownTools: REGISTERED })).toBe("");
	});

	test("without knownTools the reply is not parsed (fallback is opt-in)", () => {
		expect(parseToolCalls(LLAMA32_BARE_JSON_REPLY)).toEqual([]);
	});

	test("accepts a call inside a ```json fence and inside a bare ``` fence", () => {
		const text = [
			"```json",
			'{"name": "read_file", "arguments": {"path": "a.md"}}',
			"```",
			"```",
			'{"name": "run_command", "arguments": {"command": "wc -l a.md"}}',
			"```",
		].join("\n");
		const calls = parseToolCalls(text, { knownTools: REGISTERED });
		expect(calls).toEqual([
			{ name: "read_file", arguments: { path: "a.md" } },
			{ name: "run_command", arguments: { command: "wc -l a.md" } },
		]);
		expect(stripToolCalls(text, { knownTools: REGISTERED })).toBe("");
	});

	test('accepts "parameters" in place of "arguments"', () => {
		const text = '{"name": "read_file", "parameters": {"path": "deck/outline.md"}}';
		expect(parseToolCalls(text, { knownTools: REGISTERED })).toEqual([
			{ name: "read_file", arguments: { path: "deck/outline.md" } },
		]);
	});

	test("keeps the prose around bare calls", () => {
		const text = [
			"Reading the outline first.",
			'{"name": "read_file", "arguments": {"path": "deck/outline.md"}}',
		].join("\n");
		const opts = { knownTools: REGISTERED };
		expect(parseToolCalls(text, opts)).toHaveLength(1);
		expect(stripToolCalls(text, opts)).toBe("Reading the outline first.");
	});

	test("the ```tool_call format still works and wins over bare JSON", () => {
		const text = [
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "x"}}',
			"```",
			'{"name": "write_file", "arguments": {"path": "y", "content": "z"}}',
		].join("\n");
		const calls = parseToolCalls(text, { knownTools: REGISTERED });
		expect(calls).toEqual([{ name: "read_file", arguments: { path: "x" } }]);
	});
});

describe("parseToolCalls - JSON in an answer must NOT execute", () => {
	const opts = { knownTools: REGISTERED };

	test("a ```json example whose name is not a registered tool", () => {
		const text = [
			"Here is the request body the API expects:",
			"```json",
			'{"name": "create_user", "arguments": {"email": "a@example.com"}}',
			"```",
		].join("\n");
		expect(parseToolCalls(text, opts)).toEqual([]);
		expect(stripToolCalls(text, opts)).toBe(text);
	});

	test("a package.json snippet (name but no arguments)", () => {
		const text = ["```json", '{"name": "read_file", "version": "1.0.0"}', "```"].join("\n");
		expect(parseToolCalls(text, opts)).toEqual([]);
	});

	test("a registered name inside a code example in another language", () => {
		const text = [
			"You can build the call like this:",
			"```ts",
			'{"name": "write_file", "arguments": {"path": "notes.txt", "content": "x"}}',
			"```",
		].join("\n");
		expect(parseToolCalls(text, opts)).toEqual([]);
	});

	test("a registered-name object quoted inline in a prose sentence", () => {
		const text =
			'The model should send {"name": "run_command", "arguments": {"command": "ls build"}} to the harness.';
		expect(parseToolCalls(text, opts)).toEqual([]);
	});

	test("a call-shaped object nested inside another JSON object", () => {
		const text = [
			"```json",
			'{"example": {"name": "run_command", "arguments": {"command": "ls"}}}',
			"```",
		].join("\n");
		expect(parseToolCalls(text, opts)).toEqual([]);
	});
});

// Qwen's native markup, as the raw Ollama path returns it (the model's own
// format, untouched by Ollama's parser). Seen from qwen3.8:27b-mlx 2026-09-30.
describe("native <tool_call> markup", () => {
	const known = { knownTools: ["run_command", "write_file", "read_file"] };

	test("parses a JSON body and strips the tags from the prose", () => {
		const reply = 'Running the tests now.\n<tool_call>\n{"name": "run_command", "arguments": {"command": "bun test"}}\n</tool_call>';
		expect(parseToolCalls(reply, known)).toEqual([{ name: "run_command", arguments: { command: "bun test" } }]);
		expect(stripToolCalls(reply, known)).toBe("Running the tests now.");
	});

	test("parses the XML <function=...> body, keeping multi-line values as strings", () => {
		const reply = [
			"<tool_call>",
			"<function=write_file>",
			"<parameter=path>",
			"src/a.ts",
			"</parameter>",
			"<parameter=content>",
			"export const a = 1;",
			"export const b = 2;",
			"</parameter>",
			"</function>",
			"</tool_call>",
		].join("\n");
		expect(parseToolCalls(reply, known)).toEqual([
			{ name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;" } },
		]);
		expect(stripToolCalls(reply, known)).toBe("");
	});

	test("parses several blocks in order, and an unclosed last block", () => {
		const reply =
			'<tool_call>\n{"name": "read_file", "arguments": {"path": "a"}}\n</tool_call>\n<tool_call>\n<function=read_file>\n<parameter=path>\nb\n</parameter>\n</function>';
		expect(parseToolCalls(reply, known).map((c) => c.arguments.path)).toEqual(["a", "b"]);
	});

	test("never runs an unknown tool, an inline mention, or without knownTools", () => {
		const unknown = '<tool_call>\n{"name": "rm_rf", "arguments": {}}\n</tool_call>';
		expect(parseToolCalls(unknown, known)).toEqual([]);
		expect(stripToolCalls(unknown, known)).toBe("");
		const inline = 'Qwen can emit <tool_call>{"name": "run_command", "arguments": {}}</tool_call> tags.';
		expect(parseToolCalls(inline, known)).toEqual([]);
		const block = '<tool_call>\n{"name": "run_command", "arguments": {"command": "ls"}}\n</tool_call>';
		expect(parseToolCalls(block)).toEqual([]);
	});

	test("the fenced ```tool_call format still wins", () => {
		const reply =
			'```tool_call\n{"name": "read_file", "arguments": {"path": "fenced"}}\n```\n<tool_call>\n{"name": "read_file", "arguments": {"path": "native"}}\n</tool_call>';
		expect(parseToolCalls(reply, known)).toEqual([{ name: "read_file", arguments: { path: "fenced" } }]);
	});
});

// Pilot l4-spawn-parallel-m5, 2026-09-30: llama3.2:3b sub-agents wrote the
// wordCount fix with a regex's \s unescaped inside the JSON string. Strict JSON
// rejects \s, so the call was dropped and the agent ended with the fix unrun.
describe("parseToolCalls - invalid JSON escapes from small local models", () => {
	const opts = { knownTools: ["read_file", "write_file", "edit_file", "run_command"] };

	// Verbatim final replies of sub-agent sessions 2c28ao and ilq4st (run 070309).
	const EDIT_WITH_BARE_S =
		'{"name": "edit_file", "parameters": {"path": "src/wordcount.ts", "oldText": "", "newText": "return text.trim().split(/\\s+/).filter(Boolean).length;"}}';
	const WRITE_WITH_BARE_S =
		'{"name": "write_file", "arguments": {"path": "src/wordcount.ts", "content": "export function wordCount(text: string): number {\\n  return text.trim().split(/\\s+/).filter(Boolean).length;\\n}"}}';

	test("the pilot's edit_file call parses, and keeps \\s as a literal backslash-s", () => {
		expect(EDIT_WITH_BARE_S).toContain("/\\s+/");
		const calls = parseToolCalls(EDIT_WITH_BARE_S, opts);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("edit_file");
		expect(calls[0].arguments.newText).toBe("return text.trim().split(/\\s+/).filter(Boolean).length;");
	});

	test("the pilot's write_file call parses into runnable source", () => {
		const calls = parseToolCalls(WRITE_WITH_BARE_S, opts);
		expect(calls).toHaveLength(1);
		const content = String(calls[0].arguments.content);
		expect(content).toBe(
			"export function wordCount(text: string): number {\n  return text.trim().split(/\\s+/).filter(Boolean).length;\n}",
		);
		// The recovered source is the fix the model meant.
		const wordCount = new Function("text", content.split("\n")[1]) as (t: string) => number;
		expect(wordCount("  hello   world\n")).toBe(2);
	});

	test("valid escapes are kept as JSON defines them", () => {
		const text = '{"name": "write_file", "arguments": {"path": "a.txt", "content": "q\\"x\\\\y\\n\\u00e9 \\d"}}';
		const calls = parseToolCalls(text, opts);
		expect(calls[0].arguments.content).toBe('q"x\\y\n\u00e9 \\d');
	});

	test("a bad \\u escape is kept literally too", () => {
		const text = '{"name": "write_file", "arguments": {"path": "a.txt", "content": "C:\\users\\new"}}';
		expect(parseToolCalls(text, opts)[0].arguments.content).toBe("C:\\users\new");
	});

	test("the gates still hold: an invalid escape does not make an inline example run", () => {
		const text = `Send ${WRITE_WITH_BARE_S} to the harness.`;
		expect(parseToolCalls(text, opts)).toEqual([]);
		const other = ["```ts", WRITE_WITH_BARE_S, "```"].join("\n");
		expect(parseToolCalls(other, opts)).toEqual([]);
	});

	test("escapeInvalidBackslashesInStrings touches only string contents", () => {
		expect(escapeInvalidBackslashesInStrings('{"a": "\\s\\n\\"", "b": 1}')).toBe('{"a": "\\\\s\\n\\"", "b": 1}');
	});
});
