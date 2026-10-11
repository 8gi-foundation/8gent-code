/**
 * #3899: `8gent run` must exit non-zero when the turn ends in a failure reply,
 * and stay 0 on a finished task. Text-tool path (ollama) against a local fake
 * OpenAI-compatible endpoint; $HOME is faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFailedTurnReply } from "./local-turn-error";

const saved: Record<string, string | undefined> = {};
let repo: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	const home = mkdtempSync(join(tmpdir(), "exit3899-home-"));
	repo = mkdtempSync(join(tmpdir(), "exit3899-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	const env: Record<string, string> = {
		HOME: home,
		USERPROFILE: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
		EIGHT_TOOL_CAPABILITY_GATE: "0",
		"8GENT_TWO_STAGE_COMPACT": "0",
		EIGHT_TEXT_TOOLS: "1",
		EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
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
						message: { role: "assistant", content: "DONE: A generic constraint limits which types a type parameter accepts." },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

async function run(host: string) {
	process.env.OLLAMA_HOST = host;
	const { runRunCommand } = await import("./run");
	const err: string[] = [];
	const out: string[] = [];
	const ow = process.stdout.write.bind(process.stdout);
	const ew = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stdout.write;
	process.stderr.write = ((c: unknown) => (err.push(String(c)), true)) as typeof process.stderr.write;
	let code: number;
	try {
		code = await runRunCommand(["Explain what a generic constraint is.", "--provider", "ollama", "--model", "m", "--cwd", repo]);
	} finally {
		process.stdout.write = ow;
		process.stderr.write = ew;
	}
	return { code, out: out.join(""), err: err.join("") };
}

describe("#3899 run exit code", () => {
	test("unreachable endpoint exits non-zero and says why on stderr", async () => {
		const r = await run("http://127.0.0.1:9");
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("is not reachable");
	}, 60_000);

	test("a finished task still exits 0", async () => {
		const r = await run(`http://127.0.0.1:${server.port}`);
		expect(r.code).toBe(0);
		expect(r.out).toContain("generic constraint");
	}, 60_000);
});

describe("isFailedTurnReply", () => {
	test("recognises local failures and the honesty refusal, not normal answers", () => {
		expect(isFailedTurnReply("The local model endpoint (http://x/v1/chat/completions) is not reachable. Is LM Studio or Ollama running? (e)")).toBe(true);
		expect(isFailedTurnReply("The local model turn could not complete: boom")).toBe(true);
		expect(isFailedTurnReply("I could not complete that action.\n\n- write_file failed: x")).toBe(true);
		expect(isFailedTurnReply("Done. I wrote hello.txt.")).toBe(false);
	});
});
