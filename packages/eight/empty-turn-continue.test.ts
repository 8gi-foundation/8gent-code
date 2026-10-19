import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import {
	EMPTY_TURN_CONTINUE_LOG,
	EMPTY_TURN_CONTINUE_STEER,
	EMPTY_TURN_LENGTH_LINE,
	EMPTY_TURN_LENGTH_LOG,
	continueEmptyTurn,
} from "./empty-turn-continue";

type R = {
	text?: string;
	finishReason?: string;
	usage?: { outputTokens?: number };
	toolCalls?: unknown[];
};

// The pure decision and its bounds, then the shipping chat() native path against
// a fake OpenAI-compatible endpoint ($HOME faked).

function harness(
	replies: R[],
	opts: { aborted?: boolean; elapsedMs?: number; budgetMs?: number } = {},
) {
	const steers: string[] = [];
	const logs: string[] = [];
	let i = 0;
	return {
		steers,
		logs,
		input: {
			toolCalls: 10,
			isAborted: () => opts.aborted ?? false,
			elapsedMs: opts.elapsedMs ?? 60_000,
			budgetMs: opts.budgetMs ?? 1_500_000,
			generate: async (steer: string): Promise<R> => {
				steers.push(steer);
				return replies[i++] ?? { text: "" };
			},
			log: (line: string) => logs.push(line),
		},
	};
}

describe("continueEmptyTurn (#4444)", () => {
	test("an empty end after tool calls continues exactly once with the steer", async () => {
		const h = harness([{ text: "Wrote answer.json. The rule mirrors each row." }]);
		const out = await continueEmptyTurn({ ...h.input, result: { text: "" } });
		expect(h.steers).toEqual([EMPTY_TURN_CONTINUE_STEER]);
		expect(out.continued).toBe(true);
		expect(out.result.text).toBe("Wrote answer.json. The rule mirrors each row.");
		expect(h.logs).toHaveLength(1);
		expect(h.logs[0]).toStartWith(EMPTY_TURN_CONTINUE_LOG);
		expect(h.logs[0]).toContain("10 tool calls");
	});

	test("a second empty end stops: one generate, the empty result comes back", async () => {
		const h = harness([{ text: "   " }, { text: "should never be asked for" }]);
		const out = await continueEmptyTurn({ ...h.input, result: { text: "" } });
		expect(h.steers).toHaveLength(1);
		expect(out.continued).toBe(true);
		expect(out.result.text?.trim()).toBe("");
	});

	test("no continue after a user abort", async () => {
		const h = harness([{ text: "late" }], { aborted: true });
		const out = await continueEmptyTurn({ ...h.input, result: { text: "" } });
		expect(h.steers).toHaveLength(0);
		expect(out.continued).toBe(false);
		expect(out.result.text).toBe("");
	});

	test("an abort during the continue re-throws so the stop path handles it", async () => {
		let aborted = false;
		const h = harness([]);
		const run = continueEmptyTurn({
			...h.input,
			isAborted: () => aborted,
			result: { text: "" },
			generate: async () => {
				aborted = true;
				throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
			},
		});
		await expect(run).rejects.toThrow("Stopped by user");
	});

	test("a failed continue that was not an abort keeps the first result", async () => {
		const h = harness([]);
		const first = { text: "" };
		const out = await continueEmptyTurn({
			...h.input,
			result: first,
			generate: async () => {
				throw new Error("provider 500");
			},
		});
		expect(out.result).toBe(first);
		expect(out.continued).toBe(true);
	});

	test("no continue when the reply has text", async () => {
		const h = harness([{ text: "x" }]);
		const first: R = { text: "The answer is in answer.json." };
		const out = await continueEmptyTurn({ ...h.input, result: first });
		expect(h.steers).toHaveLength(0);
		expect(out.continued).toBe(false);
		expect(out.result).toBe(first);
	});

	test("no continue when no tool ran: nothing to finish", async () => {
		const h = harness([{ text: "x" }]);
		const out = await continueEmptyTurn({ ...h.input, toolCalls: 0, result: { text: "" } });
		expect(h.steers).toHaveLength(0);
		expect(out.continued).toBe(false);
	});

	test("no continue once the turn budget is spent; a disabled budget does not block it", async () => {
		const spent = harness([{ text: "x" }], { elapsedMs: 1_500_000, budgetMs: 1_500_000 });
		expect((await continueEmptyTurn({ ...spent.input, result: { text: "" } })).continued).toBe(
			false,
		);
		expect(spent.steers).toHaveLength(0);

		const off = harness([{ text: "x" }], { elapsedMs: 9_999_999, budgetMs: 0 });
		expect((await continueEmptyTurn({ ...off.input, result: { text: "" } })).continued).toBe(true);
	});

	test("a missing text field counts as empty", async () => {
		const h = harness([{ text: "done" }]);
		const out = await continueEmptyTurn({ ...h.input, result: {} });
		expect(out.continued).toBe(true);
		expect(out.result.text).toBe("done");
	});
});

describe("continueEmptyTurn on a length cut (#4452)", () => {
	const cut: R = {
		text: "",
		finishReason: "length",
		usage: { outputTokens: 16384 },
		toolCalls: [],
	};

	test("a length end with empty text continues once with the extra line, even with no tool calls yet", async () => {
		const h = harness([{ text: "Wrote answer.json." }]);
		const out = await continueEmptyTurn({ ...h.input, toolCalls: 0, result: cut });
		expect(h.steers).toEqual([`${EMPTY_TURN_CONTINUE_STEER} ${EMPTY_TURN_LENGTH_LINE}`]);
		expect(EMPTY_TURN_LENGTH_LINE).toBe(
			"Your last step ran out of output space while thinking. Think less, act now: make the next tool call or write the deliverable directly.",
		);
		expect(out.continued).toBe(true);
		expect(out.result.text).toBe("Wrote answer.json.");
		expect(h.logs).toContain(`${EMPTY_TURN_LENGTH_LOG} at 16384 tokens`);
	});

	test("a stop end is unchanged: plain steer, no length log, still needs tool calls", async () => {
		const h = harness([{ text: "ok" }]);
		await continueEmptyTurn({ ...h.input, result: { text: "", finishReason: "stop" } });
		expect(h.steers).toEqual([EMPTY_TURN_CONTINUE_STEER]);
		expect(h.logs.some((l) => l.startsWith(EMPTY_TURN_LENGTH_LOG))).toBe(false);

		const none = harness([{ text: "x" }]);
		const out = await continueEmptyTurn({
			...none.input,
			toolCalls: 0,
			result: { text: "", finishReason: "stop" },
		});
		expect(out.continued).toBe(false);
		expect(none.steers).toHaveLength(0);
	});

	test("a second length end stops: one generate, the empty result comes back", async () => {
		const h = harness([cut, { text: "never asked" }]);
		const out = await continueEmptyTurn({ ...h.input, result: cut });
		expect(h.steers).toHaveLength(1);
		expect(out.continued).toBe(true);
		expect(out.result.text).toBe("");
	});

	test("a length end that still carries a tool call is not treated as a cut", async () => {
		const h = harness([{ text: "x" }]);
		const out = await continueEmptyTurn({
			...h.input,
			toolCalls: 0,
			result: { ...cut, toolCalls: [{ toolName: "write_file" }] },
		});
		expect(out.continued).toBe(false);
	});

	test("abort and budget rules still hold on a length cut", async () => {
		const aborted = harness([{ text: "x" }], { aborted: true });
		expect((await continueEmptyTurn({ ...aborted.input, result: cut })).continued).toBe(false);
		const spent = harness([{ text: "x" }], { elapsedMs: 1_500_000, budgetMs: 1_500_000 });
		expect((await continueEmptyTurn({ ...spent.input, result: cut })).continued).toBe(false);
		expect(aborted.steers.length + spent.steers.length).toBe(0);
	});
});

type Reply = { content?: string; toolCall?: { name: string; args: Record<string, unknown> } };
type Body = { messages: Array<{ role: string; content: unknown }> };
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
let script: (call: number) => Reply = () => ({ content: "ok" });

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "emptyturn4444-home-"));
	repo = mkdtempSync(join(tmpdir(), "emptyturn4444-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(join(repo, "task.json"), '{"train": []}\n');
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
			const message = reply.toolCall
				? {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: `call_${bodies.length}`,
								type: "function",
								function: {
									name: reply.toolCall.name,
									arguments: JSON.stringify(reply.toolCall.args),
								},
							},
						],
					}
				: { role: "assistant", content: reply.content ?? "" };
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model ?? "m",
				choices: [{ index: 0, message, finish_reason: reply.toolCall ? "tool_calls" : "stop" }],
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

const READ: Reply = { toolCall: { name: "read_file", args: { path: "task.json" } } };
const PROMPT = "Read task.json and tell me how many train pairs it has.";
const steered = () =>
	bodies.filter((b) => JSON.stringify(b.messages).includes(EMPTY_TURN_CONTINUE_STEER));

describe("native chat(): empty end after tool calls (#4444)", () => {
	test("continues once with the steer and returns the real answer", async () => {
		bodies = [];
		script = (n) =>
			n === 0 ? READ : n === 1 ? { content: "" } : { content: "It has 0 train pairs." };
		const reply = await build().chat(PROMPT);
		expect(reply).toContain("0 train pairs");
		expect(reply).not.toContain("[harness] No reply");
		expect(steered()).toHaveLength(1);
		// The continue carries the turn's own tool call and result.
		expect(JSON.stringify(steered()[0].messages)).toContain("task.json");
	}, 60_000);

	test("a second empty end stops with the No reply note, never a loop", async () => {
		bodies = [];
		script = (n) => (n === 0 ? READ : { content: "" });
		const reply = await build().chat(PROMPT);
		expect(reply).toContain(
			"[harness] No reply: the model ended the turn without an answer after 1 tool call",
		);
		expect(steered()).toHaveLength(1);
		expect(bodies).toHaveLength(3);
	}, 60_000);

	test("a reply with text is untouched: no continue", async () => {
		bodies = [];
		script = (n) => (n === 0 ? READ : { content: "It has 0 train pairs." });
		const reply = await build().chat(PROMPT);
		expect(reply).toContain("0 train pairs");
		expect(steered()).toHaveLength(0);
		expect(bodies).toHaveLength(2);
	}, 60_000);
});
