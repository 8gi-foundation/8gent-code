/**
 * #3524: a blank model reply (empty or whitespace only, no tool calls) must
 * never come back as a finished turn. The turn gets a bounded retry, then ends as
 * an explicit failure the person can read. Text-tool path (ollama) against a
 * fake OpenAI-compatible endpoint; $HOME is faked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
let calls = 0;
let script: (call: number) => string = () => "ok";

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "blank3524-home-"));
	repo = mkdtempSync(join(tmpdir(), "blank3524-repo-"));
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
			await req.json();
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: script(calls++) },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
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

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		maxTurns: 10,
	} as ConstructorParameters<typeof Agent>[0]);
}

const PROMPT = "Using typescript, explain what a generic constraint is in two sentences.";

describe("#3524 blank model reply is a failed turn, not a finished one", () => {
	for (const [label, blank] of [
		["empty", ""],
		["whitespace only", "  \n\t  "],
	] as const) {
		test(`${label} reply on every try ends as an explicit failure after a bounded retry`, async () => {
			calls = 0;
			script = () => blank;
			const reply = await build().chat(PROMPT);
			expect(reply.trim()).not.toBe("");
			expect(reply).toContain("[harness] No reply: the model returned an empty reply");
			expect(reply).toContain("not finished");
			expect(calls).toBeGreaterThanOrEqual(2);
			expect(calls).toBeLessThanOrEqual(4);
		}, 60_000);
	}

	test("a blank first reply that is followed by a real one is retried and returned", async () => {
		calls = 0;
		script = (n) => (n === 0 ? "  " : "DONE: A generic constraint limits which types a type parameter accepts.");
		const reply = await build().chat(PROMPT);
		expect(reply).toContain("A generic constraint limits");
		expect(reply).not.toContain("[harness] No reply: the model returned an empty reply");
		expect(calls).toBe(2);
	}, 60_000);

	test("a normal reply is untouched and is not retried", async () => {
		calls = 0;
		script = () => "A generic constraint limits which types a type parameter accepts.";
		const reply = await build().chat(PROMPT);
		expect(reply).toContain("A generic constraint limits");
		expect(calls).toBe(1);
	}, 60_000);
});

describe("#3524 headless run does not report a blank reply as success", () => {
	const runWith = async (format: "text" | "stream-json") => {
		const { runRunCommand } = await import("./run");
		const out: string[] = [];
		const err: string[] = [];
		const ow = process.stdout.write.bind(process.stdout);
		const ew = process.stderr.write.bind(process.stderr);
		process.stdout.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stdout.write;
		process.stderr.write = ((c: unknown) => (err.push(String(c)), true)) as typeof process.stderr.write;
		let code: number;
		try {
			code = await runRunCommand([
				PROMPT,
				"--provider",
				"ollama",
				"--model",
				"m",
				"--cwd",
				repo,
				"--output-format",
				format,
			]);
		} finally {
			process.stdout.write = ow;
			process.stderr.write = ew;
		}
		return { code, out: out.join(""), err: err.join("") };
	};

	test("text mode exits non-zero and does not print the note as an answer", async () => {
		calls = 0;
		script = () => "";
		const r = await runWith("text");
		expect(r.code).toBe(1);
		expect(r.out).not.toContain("No reply");
		expect(r.err).toContain("[harness] No reply:");
	}, 60_000);

	test("stream-json emits a result with subtype error and exits non-zero", async () => {
		calls = 0;
		script = () => "  ";
		const r = await runWith("stream-json");
		expect(r.code).toBe(1);
		const results = r.out
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l))
			.filter((e) => e.type === "result");
		expect(results.length).toBe(1);
		expect(results[0].subtype).toBe("error");
		expect(results[0].error).toContain("[harness] No reply:");
	}, 60_000);

	test("a real reply still exits 0 with subtype ok", async () => {
		calls = 0;
		script = () => "A generic constraint limits which types a type parameter accepts.";
		const r = await runWith("stream-json");
		expect(r.code).toBe(0);
		expect(r.out).toContain('"subtype":"ok"');
	}, 60_000);
});
