/**
 * #3409: a turn stopped one step short of the commit, then read as finished.
 *
 * The circuit breaker's global limit (50 calls a turn) counted gate refusals.
 * In the pilot, 7 run_command calls were refused for && / ; chaining, so the
 * 51st call, the git_add before the commit, tripped the breaker. The loop
 * then returned the last round's prose, "Now on the branch. Let me stage and
 * commit.", as the answer, with nothing saying the turn had been cut off.
 *
 * Two fixes, both tested here on the shipping chat() path (text tools,
 * ollama) against a fake OpenAI-compatible endpoint:
 *  - a refused call executed nothing, so it no longer spends the global budget
 *    (it still counts toward the repeat and ping-pong checks);
 *  - a turn the breaker does stop says so in the reply and asks to continue.
 * $HOME is faked so the operator's memories, sessions and config stay out.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent as AgentT } from "./agent";
import { ToolLoopDetector } from "./tool-loop-detector";

let Agent: typeof import("./agent").Agent;

type Msg = { role: string; content: unknown };
type Body = { messages: Msg[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;

const FILES = 60;
const DONE_TEXT = "DONE: the done command is added, tested and committed.";

// The script the fake model follows for the current test: the reply for a
// given round (0-based), counted from the tool-result messages already in the
// conversation (the loop strips tool_call blocks from the assistant history),
// so harness-added messages cannot shift it.
let script: (round: number) => string = () => DONE_TEXT;

const toolCall = (name: string, args: Record<string, unknown>) =>
	`\`\`\`tool_call\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;

const refusedCall = (i: number) =>
	toolCall("run_command", { command: `echo smoke && echo ${i}` });
const readCall = (i: number) => toolCall("read_file", { path: join(repo, "src", `f${i}.txt`) });

function roundOf(body: Body): number {
	return body.messages.filter(
		(m) => m.role === "user" && /^Tool \w+ returned:/.test(String(m.content)),
	).length;
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "breaker3409-home-"));
	repo = mkdtempSync(join(tmpdir(), "breaker3409-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	mkdirSync(join(repo, "src"), { recursive: true });
	for (let i = 0; i < FILES; i++) writeFileSync(join(repo, "src", `f${i}.txt`), `file ${i}\n`);
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
			const body = (await req.json()) as Body;
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: script(roundOf(body)) },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function build(events?: Record<string, unknown>): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		maxTurns: 100,
		events,
	} as ConstructorParameters<typeof Agent>[0]);
}

const PROMPT =
	"Using typescript, read each file under src one at a time and report what the files contain for the release notes.";

describe("#3409 circuit breaker on the text-tool path", () => {
	test("refused calls do not spend the global budget: 8 refused + 45 executed finishes", async () => {
		const refused = 8;
		const executed = 45; // 53 calls in all: over 50, but only 45 ran
		script = (round) => {
			if (round < refused) return refusedCall(round);
			if (round < refused + executed) return readCall(round - refused);
			return DONE_TEXT;
		};
		const results: string[] = [];
		const reply = await build({
			onToolEnd: (e: { resultPreview?: string }) => results.push(e.resultPreview ?? ""),
		}).chat(PROMPT);
		// The refusals are real gate blocks from the shell sanitizer.
		expect(results.filter((r) => r.startsWith("[BLOCKED]")).length).toBe(refused);
		expect(results.length).toBe(refused + executed);
		expect(reply).toContain("the done command is added, tested and committed");
		expect(reply).not.toContain("Stopped early");
	}, 120_000);

	test("a turn the breaker stops says so and asks, never reads as finished", async () => {
		// 51 executed calls: the breaker must still trip on real execution.
		script = (round) => (round < 51 ? readCall(round) : DONE_TEXT);
		const reply = await build().chat(PROMPT);
		expect(reply).not.toContain("the done command is added");
		expect(reply).toContain("[harness] Stopped early, the task is not finished");
		expect(reply).toContain("51 executed calls this turn (limit: 50)");
		expect(reply.trimEnd().endsWith("Continue from here?")).toBe(true);
	}, 120_000);
});

describe("ToolLoopDetector refused calls", () => {
	test("a refused call does not count toward the global limit", () => {
		const d = new ToolLoopDetector({ globalLimit: 3 });
		for (let i = 0; i < 3; i++) d.record("run_command", { command: `a && ${i}` }, { refused: true });
		for (let i = 0; i < 3; i++) d.record("read_file", { path: `f${i}` });
		expect(d.check()).toBeNull();
		d.record("read_file", { path: "f9" });
		expect(d.check()?.type).toBe("global");
	});

	test("the same refused call repeated still trips the repeat check", () => {
		const d = new ToolLoopDetector();
		for (let i = 0; i < 3; i++) d.record("run_command", { command: "a && b" }, { refused: true });
		expect(d.check()?.type).toBe("repeat");
	});
});
