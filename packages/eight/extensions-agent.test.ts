/**
 * G1: a one-file TypeScript extension in ~/.8gent/extensions adds a tool the
 * model can call, a command, and a tool_call handler that blocks write_file.
 * Drives chat() on both shipping paths against a fake OpenAI-compatible
 * endpoint; $HOME is faked so the extension folder is the test's own.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
	home = mkdtempSync(join(tmpdir(), "ext-agent-home-"));
	repo = mkdtempSync(join(tmpdir(), "ext-agent-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	// A one-file extension: a tool, a command, and a block on write_file.
	mkdirSync(join(home, ".8gent", "extensions"), { recursive: true });
	writeFileSync(
		join(home, ".8gent", "extensions", "demo.ts"),
		`export default function (api: any) {
	api.registerTool({
		name: "shout",
		description: "Upper-case text",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		execute: ({ text }: { text: string }) => "SHOUTED_" + String(text).toUpperCase() + " ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
	});
	api.registerCommand({ name: "hello", description: "Say hi", run: (args: string) => "hi " + args });
	api.on("tool_call", (e: { toolName: string }) =>
		e.toolName === "write_file" ? { block: true, reason: "the demo extension froze writes" } : undefined,
	);
}
`,
	);
	ENV.HOME = home;
	ENV.EIGHT_HOME = home;
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
			const n = bodies.length;
			const call =
				n === 1
					? { name: "shout", arguments: { text: "hey" } }
					: n === 2
						? { name: "write_file", arguments: { path: join(repo, "out.txt"), content: "hello" } }
						: null;
			if (!call) return completion({ content: "DONE." }, "stop");
			if (path === "native") {
				return completion(
					{
						content: null,
						tool_calls: [
							{
								id: `call_${n}`,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							},
						],
					},
					"tool_calls",
				);
			}
			return completion(
				{ content: ["```tool_call", JSON.stringify(call), "```"].join("\n") },
				"stop",
			);
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

const PROMPT = "Shout hey, then create out.txt with hello.";

for (const [label, textTools, p] of [
	["text-tool (local)", "1", "text"],
	["native-tool", "0", "native"],
] as const) {
	describe(`one-file extension, ${label} path`, () => {
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
		const build = (
			extra: Record<string, unknown> = {
				extensions: true,
				extensionsDir: join(home, ".8gent", "extensions"),
				// A person at the keyboard, as in the TUI (tests have no TTY).
				attended: true,
			},
		) =>
			new Agent({
				model: "m",
				runtime: "ollama",
				workingDirectory: repo,
				baseUrl: `http://127.0.0.1:${server.port}`,
				...extra,
			} as ConstructorParameters<typeof Agent>[0]);

		test("the extension tool is offered and runs; its write_file block holds", async () => {
			await build().chat(PROMPT);
			expect(bodies.length).toBeGreaterThanOrEqual(3);
			expect(JSON.stringify(bodies[0])).toContain("shout");
			expect(JSON.stringify(bodies[1].messages)).toContain("SHOUTED_HEY");
			// F1: the result went through the executor, so the secret scrubber ran.
			expect(JSON.stringify(bodies[1].messages)).not.toContain(
				"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
			);
			expect(existsSync(join(repo, "out.txt"))).toBe(false);
			expect(JSON.stringify(bodies[2].messages)).toContain("the demo extension froze writes");
		});

		test("the extension command runs; an unknown one is null", async () => {
			const agent = build();
			await agent.reloadExtensions();
			expect(agent.extensionCommands()).toEqual([{ name: "hello", description: "Say hi" }]);
			expect(await agent.runExtensionCommand("hello", "there")).toBe("hi there");
			expect(await agent.runExtensionCommand("nope", "")).toBeNull();
		});

		test("off unless the host opts in", async () => {
			const agent = build({ extensionsDir: join(home, ".8gent", "extensions") });
			expect(await agent.reloadExtensions()).toEqual([]);
			expect(agent.extensionCommands()).toEqual([]);
		});

		test("never in a Table or no-tool session, even when asked", async () => {
			const table = build({
				extensions: true,
				extensionsDir: join(home, ".8gent", "extensions"),
				agentScope: "__table__",
			});
			expect(await table.reloadExtensions()).toEqual([]);
			expect(table.extensionCommands()).toEqual([]);
		});

		test("a mode that restricts tools withholds and refuses extension tools", async () => {
			const modes = await import("./modes");
			modes.getModeManager().setActiveMode("architect");
			try {
				await build().chat(PROMPT);
				for (const b of bodies) {
					const offered = JSON.stringify(b.tools ?? []) + JSON.stringify(b.messages[0]);
					expect(offered.includes('"shout"') || offered.includes("shout(")).toBe(false);
				}
				expect(JSON.stringify(bodies.slice(1))).not.toContain("SHOUTED_HEY");
			} finally {
				modes.resetModeManager();
			}
		});
	});
}
