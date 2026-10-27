import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

// Phone profile (Termux, llama.cpp llama-server, Qwen-family model): the real
// Agent.chat() native path against a fake OpenAI-compatible endpoint that
// replays the tool-call shapes llama-server emits. One real tool: read_file.
// Text-form calls (#4807): the model wrote its call into `content`, nothing ran,
// and the raw markup came back as the reply.

type Msg = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string };
type Body = { messages: Msg[] };
type Reply = { message: Record<string, unknown>; finish_reason: string };

let Agent: typeof import("./agent").Agent;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	EIGHT_VERIFY_GATE: "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let script: (call: number) => Reply = () => ({
	message: { role: "assistant", content: "ok" },
	finish_reason: "stop",
});

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "phonetools-home-"));
	repo = mkdtempSync(join(tmpdir(), "phonetools-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(join(repo, "song.txt"), "PLAYLIST-MARKER-7731\n");
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as Body & { model?: string };
			if (!Array.isArray(body.messages)) return Response.json({});
			const reply = script(bodies.length);
			bodies.push(body);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model ?? "m",
				choices: [{ index: 0, message: reply.message, finish_reason: reply.finish_reason }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	rmRetry(home);
	rmRetry(repo);
});

function build(): InstanceType<typeof Agent> {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

const call = (over: Record<string, unknown>, content: unknown = "") => ({
	message: { role: "assistant", content, tool_calls: [over] },
	finish_reason: "tool_calls",
});
const fn = (args: unknown) => ({ name: "read_file", arguments: args });
const ARGS = '{"path":"song.txt"}';
const text = (content: string): Reply => ({
	message: { role: "assistant", content },
	finish_reason: "stop",
});
const ANSWER = text("The first line is PLAYLIST-MARKER-7731.");
const PROMPT = "Read song.txt and tell me its first line.";
// The file's content reached the model: the tool really ran.
const ranTool = () =>
	bodies.slice(1).some((b) => JSON.stringify(b.messages).includes("PLAYLIST-MARKER-7731"));

const CALL = '{"name": "read_file", "arguments": {"path": "song.txt"}}';
const NATIVE: Record<string, Reply> = {
	"native call with id": call({ id: "c1", type: "function", function: fn(ARGS) }),
	"native call with no id": call({ type: "function", function: fn(ARGS) }),
	"native call with empty id": call({ id: "", type: "function", function: fn(ARGS) }),
	"native call, null content": {
		message: {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: fn(ARGS) }],
		},
		finish_reason: "tool_calls",
	},
	"native call, reasoning_content only": {
		message: {
			role: "assistant",
			content: "",
			reasoning_content: "read it",
			tool_calls: [{ id: "c1", type: "function", function: fn(ARGS) }],
		},
		finish_reason: "tool_calls",
	},
};
const TEXT: Record<string, Reply> = {
	"<tool_call> block in content": text(`<tool_call>\n${CALL}\n</tool_call>`),
	"prose then <tool_call> block": text(`I will read the file.\n<tool_call>\n${CALL}\n</tool_call>`),
	"bare JSON call in content": text(CALL),
};

describe("phone tool-call shapes through the real Agent.chat()", () => {
	for (const [name, first] of Object.entries(NATIVE)) {
		test(`${name}: the tool runs and the turn answers`, async () => {
			bodies = [];
			script = (n) => (n === 0 ? first : ANSWER);
			const reply = await build().chat(PROMPT);
			expect(reply).toContain("PLAYLIST-MARKER-7731");
			expect(ranTool()).toBe(true);
		}, 60_000);
	}

	for (const [name, first] of Object.entries(TEXT)) {
		test(`${name}: the tool runs, no raw markup reaches the person`, async () => {
			bodies = [];
			// Request 0 is the native turn; request 1 is the re-run on the text protocol,
			// where the same model writes the same call again.
			script = (n) => (n <= 1 ? first : ANSWER);
			const reply = await build().chat(PROMPT);
			expect(reply).toContain("PLAYLIST-MARKER-7731");
			expect(reply).not.toContain("tool_call");
			expect(reply).not.toContain('"arguments"');
			expect(ranTool()).toBe(true);
		}, 60_000);
	}

	test("truncated arguments: the model sees an error and is not stuck", async () => {
		bodies = [];
		script = (n) =>
			n === 0 ? call({ id: "c1", type: "function", function: fn('{"path":"song.t') }) : ANSWER;
		const reply = await build().chat(PROMPT);
		expect(reply).toContain("PLAYLIST-MARKER-7731");
		expect(ranTool()).toBe(false);
	}, 60_000);

	test("a JSON example in an ordinary answer is left alone", async () => {
		bodies = [];
		const prose = text(
			'Here is the shape:\n```json\n{"name": "made_up_tool", "arguments": {"x": 1}}\n```',
		);
		script = () => prose;
		const reply = await build().chat("Show me an example tool call shape.");
		expect(reply).toContain("made_up_tool");
		expect(bodies).toHaveLength(1);
	}, 60_000);

	test("prose around a ```json fence holding a call is an answer, not a call", async () => {
		bodies = [];
		const fenced = `To read a file, call:\n\`\`\`json\n${CALL}\n\`\`\`\nThat is the shape.`;
		script = () => text(fenced);
		const reply = await build().chat("How do I call read_file?");
		expect(reply).toContain("That is the shape.");
		expect(ranTool()).toBe(false);
		expect(bodies).toHaveLength(1);
	}, 60_000);

	test("a ```tool_call fence shown as an example is an answer, not a call", async () => {
		bodies = [];
		const fenced = `Example:\n\`\`\`tool_call\n${CALL}\n\`\`\``;
		script = () => text(fenced);
		await build().chat("Show the tool_call format.");
		expect(ranTool()).toBe(false);
		expect(bodies).toHaveLength(1);
	}, 60_000);

	test("a long answer around a bare call is not a call", async () => {
		bodies = [];
		script = () => text(`${"The format works like this. ".repeat(8)}\n${CALL}`);
		await build().chat("Explain the format.");
		expect(bodies).toHaveLength(1);
	}, 60_000);

	const SHOWN: Record<string, string> = {
		"a ~~~json fence": `Example:\n~~~json\n${CALL}\n~~~\nThat is the shape.`,
		"a 4-space indented block": `Example:\n\n    ${CALL}\n\nThat is the shape.`,
		"a tab-indented block": `Example:\n\n\t${CALL}\n\nThat is the shape.`,
		"a multi-line <pre> block": `Example:\n<pre>\n${CALL}\n</pre>`,
	};
	for (const [name, shown] of Object.entries(SHOWN)) {
		test(`${name} holding a call is an answer, not a call`, async () => {
			bodies = [];
			script = () => text(shown);
			await build().chat("Show the call format.");
			expect(ranTool()).toBe(false);
			expect(bodies).toHaveLength(1);
		}, 60_000);
	}

	test("a pretty-printed multi-line bare call still fires", async () => {
		bodies = [];
		const pretty = '{\n  "name": "read_file",\n  "arguments": {\n    "path": "song.txt"\n  }\n}';
		script = (n) => (n <= 1 ? text(pretty) : ANSWER);
		const reply = await build().chat(PROMPT);
		expect(reply).toContain("PLAYLIST-MARKER-7731");
		expect(ranTool()).toBe(true);
	}, 60_000);

	test("clearHistory puts the session back on the native path", async () => {
		bodies = [];
		script = (n) => (n <= 1 ? TEXT["<tool_call> block in content"] : ANSWER);
		const agent = build();
		await agent.chat(PROMPT);
		agent.clearHistory();
		const before = bodies.length;
		script = () => ANSWER;
		await agent.chat("Read song.txt again.");
		expect(JSON.stringify(bodies[before].messages)).not.toContain("tool_call");
	}, 60_000);

	test("once a native turn wrote a text call, the next turn goes text-first", async () => {
		bodies = [];
		script = (n) => (n <= 1 ? TEXT["<tool_call> block in content"] : ANSWER);
		const agent = build();
		await agent.chat(PROMPT);
		const before = bodies.length;
		await agent.chat("Now read song.txt again.");
		// No native-first request: the first request of turn two already carries the text protocol.
		expect(JSON.stringify(bodies[before].messages)).toContain("tool_call");
	}, 60_000);
});
