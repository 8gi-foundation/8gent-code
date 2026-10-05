/**
 * #3550: the verify-before-done nudge reaches the model on both shipping
 * paths (text-tool and native-tool) when EIGHT_VERIFY_GATE=1, and never when
 * it is unset. Drives chat() against a fake OpenAI-compatible endpoint, like
 * harness-notes-reach-model.test.ts; $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
const NUDGE_NEEDLE = "have not checked the result since the last change";

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
	home = mkdtempSync(join(tmpdir(), "verify3550-home-"));
	repo = mkdtempSync(join(tmpdir(), "verify3550-repo-"));
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
			return completion({ content: "DONE: wrote out.txt." }, "stop");
		},
	});
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
	describe(`verify gate, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
			mode = m;
		});
		afterEach(() => {
			Reflect.deleteProperty(process.env, "EIGHT_VERIFY_GATE");
			bodies = [];
			rmSync(join(repo, "out.txt"), { force: true });
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		});

		test("flag on: write then finish gets exactly one nudge", async () => {
			process.env.EIGHT_VERIFY_GATE = "1";
			await build().chat(PROMPT);
			expect(existsSync(join(repo, "out.txt"))).toBe(true);
			// The nudge is sent once; later requests in the same turn carry it
			// as history, so count the request that first carries it.
			const first = bodies.findIndex((b) =>
				b.messages.some(
					(x) => x.role === "user" && JSON.stringify(x.content).includes(NUDGE_NEEDLE),
				),
			);
			expect(first).toBeGreaterThan(0);
			const inLast = bodies[bodies.length - 1].messages.filter(
				(x) => x.role === "user" && JSON.stringify(x.content).includes(NUDGE_NEEDLE),
			);
			expect(inLast).toHaveLength(1);
		}, 60_000);

		test("flag off (default): no nudge, behaviour unchanged", async () => {
			await build().chat(PROMPT);
			expect(existsSync(join(repo, "out.txt"))).toBe(true);
			expect(nudges()).toHaveLength(0);
		}, 60_000);
	});
}

describe("verify gate, native-tool follow-up", () => {
	beforeAll(() => {
		process.env.EIGHT_TEXT_TOOLS = "0";
		process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
		process.env.EIGHT_VERIFY_GATE = "1";
		mode = "native";
	});
	afterEach(() => {
		bodies = [];
		rmSync(join(repo, "out.txt"), { force: true });
	});
	afterAll(() => {
		Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
		Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		Reflect.deleteProperty(process.env, "EIGHT_VERIFY_GATE");
	});

	const followUp = () =>
		bodies.find((b) =>
			b.messages.some((x) => x.role === "user" && JSON.stringify(x.content).includes(NUDGE_NEEDLE)),
		);

	test("the follow-up request carries the turn's write_file call and its result", async () => {
		await build().chat(PROMPT);
		const body = followUp();
		expect(body).toBeDefined();
		const raw = (body as Body).messages.map((x) => JSON.stringify(x));
		const nudgeAt = raw.findIndex((r) => r.includes(NUDGE_NEEDLE));
		const callAt = raw.findIndex((r) => r.includes('"tool_calls"') && r.includes("write_file"));
		const resultAt = raw.findIndex((r) => r.includes('"role":"tool"'));
		expect(callAt).toBeGreaterThanOrEqual(0);
		expect(resultAt).toBeGreaterThan(callAt);
		expect(nudgeAt).toBeGreaterThan(resultAt);
	}, 60_000);

	test("the follow-up goes to the provider entry that answered the turn", async () => {
		const agent = build();
		// Stand in for a hedge whose winner is not the chain's current entry.
		const winner = { provider: "ollama", model: "m-winner", local: true };
		(agent as any).kernel.hedgeExecutor = {
			enabled: false,
			run: async (
				_c: unknown,
				gen: (c: typeof winner, s?: AbortSignal) => Promise<unknown>,
				ctx: any,
			) => ({
				result: await gen(winner, ctx?.abortSignal),
				winner,
				candidatesFired: 1,
				signalWritten: false,
			}),
		};
		await agent.chat(PROMPT);
		const body = followUp();
		expect(body).toBeDefined();
		expect(bodies[0].model).toBe("m-winner");
		expect((body as Body).model).toBe("m-winner");
	}, 60_000);
});
