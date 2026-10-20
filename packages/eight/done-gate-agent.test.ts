/**
 * #4505: the done gate refuses a tests-pass claim with no test run after the last
 * write, on both shipping paths: one nudge, then on a second violation the harness ends
 * the task with done_gate "stale_or_failing_tests". Off by default. Drives chat() against a fake OpenAI-compatible endpoint, like
 * harness-notes-reach-model.test.ts; $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
const NUDGE_NEEDLE = "Run the tests, then finish.";

type Body = { model?: string; messages: Array<{ role: string; content: unknown }> };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let mode: "text" | "native" = "text";

function completion(message: Record<string, unknown>, finish: string) {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "donegate4505-home-"));
	repo = mkdtempSync(join(tmpdir(), "donegate4505-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
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
			bodies.push((await req.json()) as Body);
			// First model call of the turn writes a file; every later call answers.
			if (bodies.length === 1) {
				const args = { path: join(repo, "out.txt"), content: "hello" };
				if (mode === "native") {
					return completion(
						{
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: { name: "write_file", arguments: JSON.stringify(args) },
								},
							],
						},
						"tool_calls",
					);
				}
				const block = [
					"```tool_call",
					JSON.stringify({ name: "write_file", arguments: args }),
					"```",
				];
				return completion({ content: block.join("\n") }, "stop");
			}
			return completion({ content: "DONE: wrote out.txt. All 30 tests pass." }, "stop");
		},
	});
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

const nudges = () =>
	bodies.flatMap((b) =>
		b.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes(NUDGE_NEEDLE)),
	);

const PROMPT =
	"Using typescript conventions, create the file out.txt in the repo root with the text hello, then report back.";

for (const [label, textTools, m] of [
	["text-tool (local)", "1", "text"],
	["native-tool", "0", "native"],
] as const) {
	describe(`done gate, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
			mode = m;
		});
		afterEach(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEST_CLAIM_GATE");
			bodies = [];
			rmSync(join(repo, "out.txt"), { force: true });
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		});

		test("flag on: write, then a tests-pass claim with no test run: one nudge, then the task ends", async () => {
			process.env.EIGHT_TEST_CLAIM_GATE = "1";
			const agent = build();
			await agent.chat(PROMPT);
			expect(existsSync(join(repo, "out.txt"))).toBe(true);
			const inLast = bodies[bodies.length - 1].messages.filter(
				(x) => x.role === "user" && JSON.stringify(x.content).includes(NUDGE_NEEDLE),
			);
			expect(inLast).toHaveLength(1);
			expect(agent.getDoneGate()).toBe("stale_or_failing_tests");
			expect(agent.getLastTurnFailure()?.reason).toBe("unverified");
			expect(agent.getVerification()).toBe("tests_claimed_not_run");
		}, 60_000);

		test("testClaimGate option on, env unset: same", async () => {
			const agent = new Agent({
				model: "m",
				runtime: "ollama",
				workingDirectory: repo,
				baseUrl: `http://127.0.0.1:${server.port}`,
				testClaimGate: true,
			} as ConstructorParameters<typeof Agent>[0]);
			await agent.chat(PROMPT);
			expect(agent.getDoneGate()).toBe("stale_or_failing_tests");
		}, 60_000);

		test("flag off (default): no nudge, no field, behaviour unchanged", async () => {
			const agent = build();
			await agent.chat(PROMPT);
			expect(existsSync(join(repo, "out.txt"))).toBe(true);
			expect(nudges()).toHaveLength(0);
			expect(agent.getDoneGate()).toBeNull();
			// Nothing flagged: null, never "verified" (#4510).
			expect(agent.getVerification()).toBeNull();
		}, 60_000);
	});
}
