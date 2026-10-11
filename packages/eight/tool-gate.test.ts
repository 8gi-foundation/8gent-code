/**
 * A refusal must stop the tool on the native path too. The AI SDK swallows any
 * throw from experimental_onToolCallStart, so the YAML PreToolUse block that
 * threw there never stopped a call on the native path: the hook said blocked
 * and the file was written anyway. The refusal now runs inside each tool's
 * execute (gateToolCall). Drives chat() on both shipping paths against a fake
 * OpenAI-compatible endpoint; $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;

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
	home = mkdtempSync(join(tmpdir(), "toolgate-home-"));
	repo = mkdtempSync(join(tmpdir(), "toolgate-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	// A PreToolUse hook that blocks every write_file call.
	const script = join(home, "block.sh");
	writeFileSync(script, `echo '{"block": true, "reason": "writes are frozen"}'\n`);
	const hooks = join(home, "hooks.yaml");
	writeFileSync(
		hooks,
		`- event: PreToolUse\n  matcher: write_file\n  command: sh ${script}\n- event: PreToolUse\n  matcher: read_file\n  command: sh ${script}\n`,
	);
	ENV.EIGHT_HOOKS_YAML = hooks;
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	// The hook manager is a process singleton: another test file may have built it first.
	(await import("../hooks")).resetHookManager();
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
	(await import("../hooks")).resetHookManager();
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

for (const [label, textTools, p] of [
	["text-tool (local)", "1", "text"],
	["native-tool", "0", "native"],
] as const) {
	describe(`PreToolUse block, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
			path = p;
		});
		afterEach(() => {
			bodies = [];
			rmSync(join(repo, "out.txt"), { force: true });
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		});

		test("a write_file the hook blocks never runs, and the model is told why", async () => {
			const agent = new Agent({
				model: "m",
				runtime: "ollama",
				workingDirectory: repo,
				baseUrl: `http://127.0.0.1:${server.port}`,
			} as ConstructorParameters<typeof Agent>[0]);
			await agent.chat(PROMPT);
			expect(existsSync(join(repo, "out.txt"))).toBe(false);
			expect(bodies.length).toBeGreaterThanOrEqual(2);
			expect(JSON.stringify(bodies[1].messages)).toContain("writes are frozen");
		});

		test("a refused call starts nothing: no onToolStart, no beforeTool hook, ended as failed", async () => {
			const starts: string[] = [];
			const ends: Array<{ toolName: string; success: boolean }> = [];
			const agent = new Agent({
				model: "m",
				runtime: "ollama",
				workingDirectory: repo,
				baseUrl: `http://127.0.0.1:${server.port}`,
				events: {
					onToolStart: (e: { toolName: string }) => starts.push(e.toolName),
					onToolEnd: (e: { toolName: string; success: boolean }) => ends.push(e),
				},
			} as ConstructorParameters<typeof Agent>[0]);
			const hooks = (await import("../hooks")).getHookManager();
			const before: string[] = [];
			const spy = spyOn(hooks, "executeHooks").mockImplementation(async (type, ctx) => {
				if (type === "beforeTool") before.push(String(ctx?.tool));
				return [];
			});
			try {
				await agent.chat(PROMPT);
			} finally {
				spy.mockRestore();
			}
			expect(starts).not.toContain("write_file");
			expect(before).not.toContain("write_file");
			expect(ends.filter((e) => e.toolName === "write_file").every((e) => !e.success)).toBe(true);
		});
	});
}

describe("tool calls the harness makes itself go through the same gate", () => {
	const build = () =>
		new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
		} as ConstructorParameters<typeof Agent>[0]);

	test("runToolForResume refuses what PreToolUse blocks", async () => {
		const out = await build().runToolForResume("write_file", {
			path: join(repo, "out.txt"),
			content: "hello",
		});
		expect(out).toContain("writes are frozen");
		expect(existsSync(join(repo, "out.txt"))).toBe(false);
	});

	test("the pre-tool router does not pre-fetch through a blocked tool", async () => {
		writeFileSync(join(repo, "secret.txt"), "ROUTER_SECRET_BODY\n");
		const agent = build();
		const internals = agent as unknown as {
			preToolRouter: { classify: () => unknown };
			tryRunPreToolRouter: (m: string) => Promise<void>;
		};
		const route = (decision: unknown) => {
			internals.preToolRouter.classify = () => decision;
			return internals.tryRunPreToolRouter("look at it");
		};
		// read_file is blocked by the hook: nothing is pre-fetched.
		await route({
			strategy: "fileread",
			confidence: 0.9,
			args: { path: join(repo, "secret.txt") },
		});
		expect(JSON.stringify(agent.getMessageHistory())).not.toContain("ROUTER_SECRET_BODY");
		// Control: list_files is not blocked, so the router still pre-fetches.
		await route({ strategy: "glob", confidence: 0.9, args: { pattern: "*.txt" } });
		expect(JSON.stringify(agent.getMessageHistory())).toContain("secret.txt");
	});
});
