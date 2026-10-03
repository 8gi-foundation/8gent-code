/**
 * #3419: the turn-end side reviewer is wired at one call site in chat() and
 * is off unless EIGHT_TURN_REVIEW is exactly "1".
 *
 * Drives the shipping chat() path (text-tool, local provider) against a fake
 * OpenAI-compatible endpoint, like harness-notes-reach-model.test.ts. $HOME is
 * a temp folder so the operator's sessions and config stay out of the test.
 * Temp dirs come from tests/temp-dirs.ts so none outlive the run (#3285).
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
/**
 * Each Agent starts OnboardingManager.detectIntegrations() without awaiting
 * it, and that later writes <home>/.8gent/user.json. Left running, it
 * recreated the temp home after cleanup (#3285), so the file waits for every
 * one of them before removing its temp dirs.
 */
const pendingDetect: Promise<unknown>[] = [];
let detectSpy: { mockRestore: () => void } | undefined;

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
	home = tempDir("turnreview3419-home-");
	repo = tempDir("turnreview3419-repo-");
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	saved.EIGHT_TURN_REVIEW = process.env.EIGHT_TURN_REVIEW;
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	saved.EIGHT_TEXT_TOOLS = process.env.EIGHT_TEXT_TOOLS;
	({ Agent } = await import("./agent"));
	const { OnboardingManager } = await import("../self-autonomy/onboarding");
	const realDetect = OnboardingManager.prototype.detectIntegrations;
	detectSpy = spyOn(OnboardingManager.prototype, "detectIntegrations").mockImplementation(function (
		this: InstanceType<typeof OnboardingManager>,
		...args: Parameters<typeof realDetect>
	) {
		const p = realDetect.apply(this, args);
		pendingDetect.push(p.catch(() => {}));
		return p;
	});
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
	process.env.EIGHT_TEXT_TOOLS = ENV.EIGHT_TEXT_TOOLS;
	rmSync(join(repo, "stray.ts"), { force: true });
});

afterAll(async () => {
	await Promise.allSettled(pendingDetect);
	detectSpy?.mockRestore();
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	cleanupTempDirs();
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
	prepare?: (agent: AgentT) => void,
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
		const agent = build();
		prepare?.(agent);
		const reply = await agent.chat(prompt);
		return { reply, lines };
	} finally {
		spy.mockRestore();
	}
}

/** Count calls to the private turn body, still running the real one. */
function countTurns(agent: AgentT): { n: number } {
	const a = agent as unknown as { runChatTurn: (...args: unknown[]) => Promise<string> };
	const counter = { n: 0 };
	const real = a.runChatTurn.bind(agent);
	a.runChatTurn = (...args: unknown[]) => {
		counter.n++;
		return real(...args);
	};
	return counter;
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
		expect(
			r.lines.some((l) =>
				l.includes("Not asked for: changed stray.ts (prompt named src/parse.ts)"),
			),
		).toBe(true);
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

	test("a turn the infinite-mode heal retries is reviewed exactly once", async () => {
		// The heal retry only exists on the native path. The first model attempt
		// throws a transient error from inside the turn's try block (the first
		// abortController assignment); the real self-heal waits about 1 s and
		// retries through runChatTurn. Were it to call chat() again, the review
		// would print twice.
		process.env.EIGHT_TEXT_TOOLS = "0";
		let counter = { n: 0 };
		const r = await turn("1", PROMPT, UNASKED_TURN(), (agent) => {
			const a = agent as unknown as { infiniteModeActive: boolean };
			a.infiniteModeActive = true;
			let controller: AbortController | null = null;
			let thrown = false;
			Object.defineProperty(agent, "abortController", {
				configurable: true,
				get: () => controller,
				set: (v: AbortController | null) => {
					if (v && !thrown) {
						thrown = true;
						throw new Error("ETIMEDOUT simulated");
					}
					controller = v;
				},
			});
			counter = countTurns(agent);
		});
		expect(counter.n).toBe(2); // the outer turn plus one heal retry
		expect(r.reply).toBe("Updated the parser.");
		expect(r.lines.filter((l) => l.includes("Not asked for: changed stray.ts"))).toHaveLength(1);
		expect(r.lines.length).toBeLessThanOrEqual(3);
	}, 20_000);

	test("a turn that throws propagates the error and prints no review line", async () => {
		process.env.EIGHT_TURN_REVIEW = "1";
		const agent = build();
		(agent as unknown as { runChatTurn: () => Promise<string> }).runChatTurn = async () => {
			throw new Error("provider exploded");
		};
		const lines: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			const text = args.map(String).join(" ");
			if (text.startsWith("[turn-review]")) lines.push(text);
		});
		try {
			await expect(agent.chat(PROMPT)).rejects.toThrow("provider exploded");
		} finally {
			spy.mockRestore();
		}
		expect(lines).toEqual([]);
	});
});
