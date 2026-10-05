/**
 * Tool history on the wire (#3547).
 *
 * ChatMessage carries `toolCalls` (assistant) and `toolCallId` (tool reply),
 * but the three serialisers in packages/providers/index.ts copied only role and
 * content. Step two of any tool loop then reached the provider as an assistant
 * turn with empty text and no calls, followed by a tool reply with no id:
 * OpenAI-style APIs answer 400, Anthropic sees plain user text.
 *
 * Each test drives ProviderManager.chat() against a fake fetch and inspects the
 * JSON body that would have left the machine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ChatMessage, ProviderManager } from "../index";

const ISOLATED_ENV = [
	"HOME",
	"EIGHT_DATA_DIR",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"EIGHT_EFFORT_POLICY",
] as const;

let tmpDir: string;
let settingsPath: string;
let saved: Array<readonly [string, string | undefined]>;
const realFetch = globalThis.fetch;
let captured: Record<string, any> | null;

function useProvider(activeProvider: string, activeModel: string, providers: object, reply: object) {
	fs.writeFileSync(settingsPath, JSON.stringify({ activeProvider, activeModel, providers }));
	globalThis.fetch = (async (_url: string, init: { body: string }) => {
		captured = JSON.parse(init.body);
		return new Response(JSON.stringify(reply), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

const useOpenAI = () =>
	useProvider("openai", "gpt-test", { openai: { enabled: true, apiKey: "test-key" } }, {
		choices: [{ message: { content: "done" } }],
	});
const useAnthropic = () =>
	useProvider("anthropic", "claude-test", { anthropic: { enabled: true, apiKey: "test-key" } }, {
		content: [{ type: "text", text: "done" }],
	});
const useOllama = () =>
	useProvider("ollama", "qwen-test", { ollama: { enabled: true } }, {
		message: { content: "done" },
	});

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-history-wire-"));
	settingsPath = path.join(tmpDir, "providers.json");
	saved = ISOLATED_ENV.map((k) => [k, process.env[k]] as const);
	process.env.HOME = tmpDir;
	process.env.EIGHT_DATA_DIR = path.join(tmpDir, ".8gent");
	delete process.env.OPENAI_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.EIGHT_EFFORT_POLICY;
	captured = null;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A two-step tool loop: user asks, assistant calls a tool, tool answers. */
const toolLoop: ChatMessage[] = [
	{ role: "system", content: "be terse" },
	{ role: "user", content: "weather in Dublin?" },
	{
		role: "assistant",
		content: "",
		toolCalls: [{ id: "call_abc", name: "get_weather", arguments: { city: "Dublin" } }],
	},
	{ role: "tool", content: "12C and raining", toolCallId: "call_abc" },
];

/** A history with no tools at all: must serialise exactly as before. */
const plain: ChatMessage[] = [
	{ role: "system", content: "be terse" },
	{ role: "user", content: "hi" },
	{ role: "assistant", content: "hello" },
	{ role: "user", content: "bye" },
];

const chat = (messages: ChatMessage[]) => new ProviderManager(settingsPath).chat({ messages });

describe("OpenAI-compatible shape", () => {
	test("assistant tool calls become tool_calls with null content, tool reply keeps its id", async () => {
		useOpenAI();
		await chat(toolLoop);
		const msgs = captured!.messages;
		expect(msgs[2]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call_abc",
					type: "function",
					function: { name: "get_weather", arguments: JSON.stringify({ city: "Dublin" }) },
				},
			],
		});
		expect(msgs[3]).toEqual({ role: "tool", content: "12C and raining", tool_call_id: "call_abc" });
	});

	test("assistant text alongside tool calls is kept", async () => {
		useOpenAI();
		const withText = toolLoop.map((m) => (m.toolCalls ? { ...m, content: "checking" } : m));
		await chat(withText);
		expect(captured!.messages[2].content).toBe("checking");
		expect(captured!.messages[2].tool_calls).toHaveLength(1);
	});

	test("no-tools history is unchanged on the wire", async () => {
		useOpenAI();
		await chat(plain);
		expect(captured!.messages).toEqual(plain.map((m) => ({ role: m.role, content: m.content })));
	});

	test("tool-call arguments are anonymized before cloud egress and the email never leaves", async () => {
		useOpenAI();
		const pii: ChatMessage[] = [
			{ role: "user", content: "email the report" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "c1", name: "send_mail", arguments: { to: "sarah.connor@example.com" } }],
			},
			{ role: "tool", content: "sent", toolCallId: "c1" },
		];
		await chat(pii);
		const body = JSON.stringify(captured);
		expect(body).not.toContain("sarah.connor@example.com");
		const args = JSON.parse(captured!.messages[1].tool_calls[0].function.arguments);
		expect(typeof args.to).toBe("string");
		expect(args.to).not.toContain("@example.com");
	});
});

describe("Anthropic shape", () => {
	test("assistant tool calls become tool_use blocks, tool reply becomes tool_result", async () => {
		useAnthropic();
		await chat(toolLoop);
		const msgs = captured!.messages;
		expect(captured!.system).toBe("be terse");
		expect(msgs[1]).toEqual({
			role: "assistant",
			content: [{ type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "Dublin" } }],
		});
		expect(msgs[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call_abc", content: "12C and raining" }],
		});
	});

	test("parallel tool replies merge into one user turn", async () => {
		useAnthropic();
		await chat([
			{ role: "user", content: "two cities" },
			{
				role: "assistant",
				content: "on it",
				toolCalls: [
					{ id: "a", name: "get_weather", arguments: { city: "Dublin" } },
					{ id: "b", name: "get_weather", arguments: { city: "Cork" } },
				],
			},
			{ role: "tool", content: "12C", toolCallId: "a" },
			{ role: "tool", content: "14C", toolCallId: "b" },
		]);
		const msgs = captured!.messages;
		expect(msgs).toHaveLength(3);
		expect(msgs[1].content[0]).toEqual({ type: "text", text: "on it" });
		expect(msgs[1].content).toHaveLength(3);
		expect(msgs[2].role).toBe("user");
		expect(msgs[2].content.map((b: any) => b.tool_use_id)).toEqual(["a", "b"]);
	});

	test("no-tools history is unchanged on the wire", async () => {
		useAnthropic();
		await chat(plain);
		expect(captured!.messages).toEqual(
			plain
				.filter((m) => m.role !== "system")
				.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
		);
	});
});

describe("Ollama shape", () => {
	test("assistant tool calls become tool_calls with object arguments, tool reply names its tool", async () => {
		useOllama();
		await chat(toolLoop);
		const msgs = captured!.messages;
		expect(msgs[2]).toEqual({
			role: "assistant",
			content: "",
			tool_calls: [{ function: { name: "get_weather", arguments: { city: "Dublin" } } }],
		});
		expect(msgs[3]).toEqual({ role: "tool", content: "12C and raining", tool_name: "get_weather" });
	});

	test("no-tools history is unchanged on the wire", async () => {
		useOllama();
		await chat(plain);
		expect(captured!.messages).toEqual(plain.map((m) => ({ role: m.role, content: m.content })));
	});
});
