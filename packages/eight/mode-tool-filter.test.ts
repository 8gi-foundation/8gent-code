/**
 * #3389: the active mode's tool restrictions are real on the request path.
 * A restricted mode never advertises a withheld tool to the model, and a
 * withheld tool the model emits anyway is refused before it runs. Drives chat()
 * against a fake OpenAI-compatible endpoint on both shipping paths (text-tool
 * and native-tool); $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;
let modes: typeof import("./modes");

type Body = {
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ function?: { name?: string } }>;
};

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let path: "text" | "native" = "text";

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
	home = mkdtempSync(join(tmpdir(), "modefilter3389-home-"));
	repo = mkdtempSync(join(tmpdir(), "modefilter3389-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	modes = await import("./modes");
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			bodies.push((await req.json()) as Body);
			// First model call tries to write a file; every later call answers.
			if (bodies.length === 1) {
				const args = { path: join(repo, "out.txt"), content: "hello" };
				if (path === "native") {
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
			return completion({ content: "DONE." }, "stop");
		},
	});
});

afterAll(async () => {
	server?.stop(true);
	// The agent opened a memory database under home; Windows will not delete it while open.
	(await import("../memory/index")).resetMemoryManager();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

const PROMPT = "Create the file out.txt in the repo root with the text hello, then report back.";

const offered = (b: Body): string => {
	if (path === "native") return (b.tools ?? []).map((t) => t.function?.name).join(",");
	// The text-tool catalog lines look like `name(args) - description`.
	return b.messages
		.filter((m) => m.role === "system")
		.flatMap((m) => String(m.content).split("\n"))
		.filter((l) => /^[a-z_]+\(/.test(l))
		.join("\n");
};

for (const [label, textTools, p] of [
	["text-tool (local)", "1", "text"],
	["native-tool", "0", "native"],
] as const) {
	describe(`mode tool filter, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
			path = p;
		});
		afterEach(() => {
			modes.resetModeManager();
			bodies = [];
			rmSync(join(repo, "out.txt"), { force: true });
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		});
		const build = () =>
			new Agent({
				model: "m",
				runtime: "ollama",
				workingDirectory: repo,
				baseUrl: `http://127.0.0.1:${server.port}`,
			} as ConstructorParameters<typeof Agent>[0]);

		test("default mode: write_file is offered and runs (control)", async () => {
			await build().chat(PROMPT);
			expect(offered(bodies[0])).toContain("write_file");
			expect(existsSync(join(repo, "out.txt"))).toBe(true);
		});

		test("architect mode: write_file is never advertised", async () => {
			modes.getModeManager().setActiveMode("architect");
			await build().chat(PROMPT);
			for (const b of bodies) expect(offered(b)).not.toContain("write_file");
		});

		test("architect mode: a write_file call the model emits anyway is refused, nothing written", async () => {
			modes.getModeManager().setActiveMode("architect");
			await build().chat(PROMPT);
			expect(existsSync(join(repo, "out.txt"))).toBe(false);
		});
	});
}
