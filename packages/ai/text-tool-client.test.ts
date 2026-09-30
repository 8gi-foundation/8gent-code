import { describe, expect, it } from "bun:test";
import {
	mergeToolCalls,
	runTextToolTurn,
	type TextToolMessage,
} from "./text-tool-client";
import type { ToolSpec } from "./text-tools";

const TOOLS: ToolSpec[] = [
	{
		name: "read_file",
		description: "Read a file from disk.",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
	{
		name: "list_dir",
		description: "List a directory.",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
];

describe("runTextToolTurn", () => {
	it("parses a tool_call block and strips the prose", async () => {
		const raw = [
			"Let me read that file.",
			"```tool_call",
			'{"name": "read_file", "arguments": {"path": "a.txt"}}',
			"```",
		].join("\n");

		const turn = await runTextToolTurn({
			messages: [{ role: "user", content: "read a.txt" }],
			tools: TOOLS,
			call: async () => raw,
		});

		expect(turn.toolCalls).toEqual([
			{ name: "read_file", arguments: { path: "a.txt" } },
		]);
		expect(turn.content).toBe("Let me read that file.");
	});

	it("returns plain prose with no tool calls", async () => {
		const turn = await runTextToolTurn({
			messages: [{ role: "user", content: "hi" }],
			tools: TOOLS,
			call: async () => "  Just a plain answer.  ",
		});

		expect(turn.toolCalls).toEqual([]);
		expect(turn.content).toBe("Just a plain answer.");
	});

	it("does not throw on a malformed tool_call block and preserves content", async () => {
		const raw = [
			"Trying a tool.",
			"```tool_call",
			"{ this is not valid json",
			"```",
		].join("\n");

		const turn = await runTextToolTurn({
			messages: [{ role: "user", content: "x" }],
			tools: TOOLS,
			call: async () => raw,
		});

		expect(turn.toolCalls).toEqual([]);
		// The prose before the malformed block is preserved.
		expect(turn.content).toContain("Trying a tool.");
	});

	it("passes the tool instructions to the call mock", async () => {
		let received: TextToolMessage[] | null = null;

		await runTextToolTurn({
			messages: [{ role: "user", content: "go" }],
			tools: TOOLS,
			call: async (messages) => {
				received = messages;
				return "ok";
			},
		});

		expect(received).not.toBeNull();
		const system = received![0];
		expect(system.role).toBe("system");
		expect(system.content).toContain("tool_call");
		expect(system.content).toContain("read_file");
		expect(system.content).toContain("list_dir");
	});

	it("prepends instructions to an existing system message, original text after", async () => {
		let received: TextToolMessage[] | null = null;
		const original = "You are a helpful assistant.";

		await runTextToolTurn({
			messages: [
				{ role: "system", content: original },
				{ role: "user", content: "go" },
			],
			tools: TOOLS,
			call: async (messages) => {
				received = messages;
				return "ok";
			},
		});

		const system = received![0];
		expect(system.role).toBe("system");
		expect(system.content).toContain("tool_call");
		expect(system.content).toContain(original);
		// Instructions come before the original system text.
		const instrIdx = system.content.indexOf("tool_call");
		const origIdx = system.content.indexOf(original);
		expect(instrIdx).toBeLessThan(origIdx);
		// User message still present after the system message.
		expect(received![1]).toEqual({ role: "user", content: "go" });
	});

	it("inserts a leading system message when none exists", async () => {
		let received: TextToolMessage[] | null = null;

		await runTextToolTurn({
			messages: [
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			],
			tools: TOOLS,
			call: async (messages) => {
				received = messages;
				return "ok";
			},
		});

		expect(received![0].role).toBe("system");
		expect(received![1]).toEqual({ role: "user", content: "first" });
		expect(received![2]).toEqual({ role: "user", content: "second" });
	});

	it("passes messages through unchanged when tools is empty", async () => {
		const input: TextToolMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "u" },
		];
		const snapshot = structuredClone(input);
		let received: TextToolMessage[] | null = null;

		await runTextToolTurn({
			messages: input,
			tools: [],
			call: async (messages) => {
				received = messages;
				return "answer";
			},
		});

		// `received` is only assigned inside the async callback above, so the
		// compiler's flow analysis still types it as `null` here. Pin the
		// matcher generic to the declared union so the assertion type-checks.
		expect<TextToolMessage[] | null>(received).toEqual(snapshot);
		// Input array and objects are not mutated.
		expect(input).toEqual(snapshot);
	});

	it("does not mutate the caller's array or objects in the prepend case", async () => {
		const input: TextToolMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "u" },
		];
		const snapshot = structuredClone(input);

		await runTextToolTurn({
			messages: input,
			tools: TOOLS,
			call: async () => "ok",
		});

		expect(input).toEqual(snapshot);
		// The original system object's content is unchanged.
		expect(input[0].content).toBe("sys");
	});

	it("merges only the first system message, passing later system messages through", async () => {
		let received: TextToolMessage[] | null = null;
		const firstSystem = "You are the first system prompt.";
		const secondSystem: TextToolMessage = {
			role: "system",
			content: "A second system message that must stay untouched.",
		};

		await runTextToolTurn({
			messages: [
				{ role: "system", content: firstSystem },
				secondSystem,
				{ role: "user", content: "go" },
			],
			tools: TOOLS,
			call: async (messages) => {
				received = messages;
				return "ok";
			},
		});

		expect(received![0].role).toBe("system");
		expect(received![0].content).toContain(firstSystem);
		expect(received![0].content).toContain("tool_call");
		// The second system message passes through unchanged.
		expect(received![1]).toEqual(secondSystem);
	});

	it("synthesizes a single leading system message for empty messages with tools", async () => {
		let received: TextToolMessage[] | null = null;

		await runTextToolTurn({
			messages: [],
			tools: TOOLS,
			call: async (messages) => {
				received = messages;
				return "ok";
			},
		});

		expect(received!.length).toBe(1);
		expect(received![0].role).toBe("system");
		expect(received![0].content).toContain("tool_call");
	});

	it("propagates a rejection from call", async () => {
		const boom = new Error("model offline");
		await expect(
			runTextToolTurn({
				messages: [{ role: "user", content: "go" }],
				tools: TOOLS,
				call: async () => {
					throw boom;
				},
			}),
		).rejects.toBe(boom);
	});
});

describe("runTextToolTurn with structured tool_calls from the call", () => {
	const known: ToolSpec[] = [
		{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
		{ name: "list_files", description: "list", parameters: { type: "object", properties: {} } },
	];

	it("runs structured calls in order and keeps the prose as the reply", async () => {
		const turn = await runTextToolTurn({
			messages: [{ role: "user", content: "x" }],
			tools: known,
			call: async () => ({
				content: "Let me look.",
				toolCalls: [
					{ name: "list_files", arguments: { path: "." } },
					{ name: "read_file", arguments: { path: "README.md" } },
				],
			}),
		});
		expect(turn.content).toBe("Let me look.");
		expect(turn.toolCalls).toEqual([
			{ name: "list_files", arguments: { path: "." } },
			{ name: "read_file", arguments: { path: "README.md" } },
		]);
	});

	it("ignores a structured call to an unregistered tool", async () => {
		const turn = await runTextToolTurn({
			messages: [{ role: "user", content: "x" }],
			tools: known,
			call: async () => ({
				content: "ok",
				toolCalls: [
					{ name: "rm_rf", arguments: {} },
					{ name: "read_file", arguments: { path: "a" } },
				],
			}),
		});
		expect(turn.toolCalls).toEqual([{ name: "read_file", arguments: { path: "a" } }]);
	});

	it("dedupes a call present both in the text and as a structured call", async () => {
		const text =
			'Reading it.\n```tool_call\n{"name": "read_file", "arguments": {"path": "a", "limit": 5}}\n```';
		const turn = await runTextToolTurn({
			messages: [{ role: "user", content: "x" }],
			tools: known,
			call: async () => ({
				content: text,
				toolCalls: [
					{ name: "read_file", arguments: { limit: 5, path: "a" } },
					{ name: "list_files", arguments: { path: "." } },
				],
			}),
		});
		expect(turn.content).toBe("Reading it.");
		expect(turn.toolCalls).toEqual([
			{ name: "read_file", arguments: { path: "a", limit: 5 } },
			{ name: "list_files", arguments: { path: "." } },
		]);
	});
});

describe("mergeToolCalls", () => {
	it("keeps text calls first, drops unknown and duplicate structured calls", () => {
		expect(
			mergeToolCalls(
				[{ name: "a", arguments: { x: { p: 1, q: [1, 2] } } }],
				[
					{ name: "a", arguments: { x: { q: [1, 2], p: 1 } } },
					{ name: "a", arguments: { x: 2 } },
					{ name: "a", arguments: { x: 2 } },
					{ name: "zzz", arguments: {} },
				],
				["a"],
			),
		).toEqual([
			{ name: "a", arguments: { x: { p: 1, q: [1, 2] } } },
			{ name: "a", arguments: { x: 2 } },
		]);
	});
});
