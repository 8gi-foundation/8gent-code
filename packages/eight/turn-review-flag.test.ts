/**
 * #3419: the turn-end side reviewer is wired at one call site in chat() and
 * is off unless EIGHT_TURN_REVIEW is exactly "1".
 *
 * Drives the shipping chat() path (text-tool, local provider) against a fake
 * OpenAI-compatible endpoint, like harness-notes-reach-model.test.ts. $HOME is
 * a temp folder so the operator's sessions and config stay out of the test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
/** Replies the fake model gives, in order; the last one repeats. */
let script: Array<Record<string, unknown>> = [];
let served = 0;

const say = (content: string) => ({ role: "assistant", content });
const callWrite = (p: string) => ({
	role: "assistant",
	content: null,
	tool_calls: [
		{
			id: "call_1",
			type: "function",
			function: {
				name: "write_file",
				arguments: JSON.stringify({ path: p, content: "export const x = 1;\n" }),
			},
		},
	],
});

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "turnreview3419-home-"));
	repo = mkdtempSync(join(tmpdir(), "turnreview3419-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	saved.EIGHT_TURN_REVIEW = process.env.EIGHT_TURN_REVIEW;
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			const message = script[Math.min(served, script.length - 1)];
			served++;
			const toolTurn = Array.isArray((message as { tool_calls?: unknown }).tool_calls);
			return Response.json({
				id: `c${served}`,
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [{ index: 0, message, finish_reason: toolTurn ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	if (saved.EIGHT_TURN_REVIEW === undefined) delete process.env.EIGHT_TURN_REVIEW;
	else process.env.EIGHT_TURN_REVIEW = saved.EIGHT_TURN_REVIEW;
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** Run one turn and return the reply plus every [turn-review] console line. */
async function turn(
	flag: string | undefined,
	prompt: string,
	replies: Array<Record<string, unknown>>,
) {
	if (flag === undefined) delete process.env.EIGHT_TURN_REVIEW;
	else process.env.EIGHT_TURN_REVIEW = flag;
	script = replies;
	served = 0;
	const lines: string[] = [];
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		const text = args.map(String).join(" ");
		if (text.startsWith("[turn-review]")) lines.push(text);
	});
	try {
		const reply = await build().chat(prompt);
		return { reply, lines };
	} finally {
		spy.mockRestore();
	}
}

const UNASKED_TURN = () => [callWrite("stray.ts"), say("Updated the parser.")];
const PROMPT = "Fix the off-by-one in src/parse.ts";

describe("turn-end side reviewer flag (#3419)", () => {
	test("flag unset: no review line, and the reply matches a flag-on run", async () => {
		const off = await turn(undefined, PROMPT, UNASKED_TURN());
		expect(off.lines).toEqual([]);
		expect(served).toBeGreaterThan(1); // the tool call really ran
		expect(existsSync(join(repo, "stray.ts"))).toBe(true);
		rmSync(join(repo, "stray.ts"));

		const on = await turn("1", PROMPT, UNASKED_TURN());
		// Same turn, same reply: the reviewer never changes the result.
		expect(on.reply).toBe(off.reply);
		expect(on.lines.length).toBeGreaterThan(0);
		rmSync(join(repo, "stray.ts"), { force: true });
	});

	for (const value of ["0", "true", "yes", "", " 1"]) {
		test(`EIGHT_TURN_REVIEW=${JSON.stringify(value)} is off`, async () => {
			const r = await turn(value, PROMPT, UNASKED_TURN());
			expect(r.lines).toEqual([]);
			rmSync(join(repo, "stray.ts"), { force: true });
		});
	}

	test("flag on: flags the unasked file and the missing test run, at most 3 lines", async () => {
		const r = await turn("1", PROMPT, UNASKED_TURN());
		expect(r.lines.length).toBeLessThanOrEqual(3);
		expect(r.lines.some((l) => l.includes("Unasked: changed stray.ts"))).toBe(true);
		expect(r.lines.some((l) => l.includes("no test command ran after editing stray.ts"))).toBe(
			true,
		);
		expect(readFileSync(join(repo, "stray.ts"), "utf-8")).toContain("export const x");
		rmSync(join(repo, "stray.ts"), { force: true });
	});

	test("flag on: a clean turn (no tools, plain answer) stays silent", async () => {
		const r = await turn("1", "What does src/parse.ts do?", [say("It parses the config file.")]);
		expect(r.lines).toEqual([]);
	});
});
