/**
 * #3222: the system prompt and the tool list are byte-stable within a
 * session, and across two agent builds with the same config, so a local
 * server's prefix (KV) cache can reuse them on every turn.
 *
 * This drives the shipping chat() path against a fake OpenAI-compatible
 * endpoint and compares the request bodies the model would receive. Nothing
 * here reads a prompt string out of the agent's internals: what is compared is
 * what goes over the wire.
 *
 * $HOME is faked so the operator's real memories, sessions, and ~/.claude
 * files stay out of the test.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWhenReleased } from "../core/open-files";
import type { Agent as AgentT } from "./agent";

// Loaded in beforeAll, after $HOME and EIGHT_DATA_DIR point at a temp dir: the
// memory store resolves its path at import time, and a static import would
// read the operator's real memories.
let Agent: typeof import("./agent").Agent;
let ToolRegistry: typeof import("./tool-registry").ToolRegistry;
let tools: typeof import("../ai/tools");

type Msg = { role: string; content: unknown };
type Body = { messages: Msg[]; tools?: unknown[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let memoryDb: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];

function remember(text: string): void {
	const db = new Database(memoryDb);
	db.run(
		"CREATE TABLE IF NOT EXISTS memories (scope TEXT, content_text TEXT, importance REAL, created_at INTEGER, deleted_at INTEGER)",
	);
	db.run("INSERT INTO memories VALUES ('global', ?, 1, ?, NULL)", [text, Date.now()]);
	db.close();
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "stable3222-home-"));
	repo = mkdtempSync(join(tmpdir(), "stable3222-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	memoryDb = join(home, ".8gent", "memory", "memory.db");
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	remember("SENTINEL_3222_memory_one");
	({ Agent } = await import("./agent"));
	({ ToolRegistry } = await import("./tool-registry"));
	tools = await import("../ai/tools");
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			bodies.push((await req.json()) as Body);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
});

afterAll(async () => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	tools?.resetRuntimeParams();
	// Close the memory databases the agents opened under the temp home first:
	// Windows refuses to delete a directory holding an open file.
	(await import("../memory")).resetMemoryManager();
	removeWhenReleased(home);
	removeWhenReleased(repo);
});

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** The first request body the model receives for one chat() turn. */
async function turn(agent: AgentT, text: string): Promise<Body> {
	const start = bodies.length;
	await agent.chat(text);
	const body = bodies[start];
	if (!body) throw new Error(`no model request for "${text}"`);
	return body;
}

const bytes = (v: unknown) => JSON.stringify(v);
const system = (b: Body) => bytes(b.messages.filter((m) => m.role === "system"));

// Two paths ship: the compact prompt with the text-tool protocol for local
// servers, and the full prompt with native tools. Both are driven through the
// ollama runtime so every request lands on the fake endpoint; EIGHT_TEXT_TOOLS
// picks the path, the same lever operators use.
for (const [label, textTools] of [
	["text-tool (local)", "1"],
	["native-tool (full prompt)", "0"],
] as const) {
	describe(`prefix stability, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		});

		test("two agent builds with the same config send byte-identical system + tools", async () => {
			const a = await turn(build(), "hello there");
			// A memory saved between sessions must not move the prefix.
			remember(`SENTINEL_3222_memory_${label}`);
			const b = await turn(build(), "hello there");
			expect(system(b)).toBe(system(a));
			expect(bytes(b.tools)).toBe(bytes(a.tools));
			// The memories still reach the model, after the prefix.
			expect(bytes(a.messages)).toContain("SENTINEL_3222_memory_one");
			expect(bytes(b.messages)).toContain(`SENTINEL_3222_memory_${label}`);
		}, 60_000);

		test("turn 2 extends turn 1: same system, same tools, history append-only", async () => {
			const agent = build();
			const t1 = await turn(agent, "hello there");
			const t2 = await turn(agent, "and again");
			expect(system(t2)).toBe(system(t1));
			expect(bytes(t2.tools)).toBe(bytes(t1.tools));
			expect(bytes(t2.messages.slice(0, t1.messages.length))).toBe(bytes(t1.messages));
		}, 60_000);

		test("self-appended context and voice mode arrive as a trailing message, not a prompt rewrite", async () => {
			const agent = build();
			const t1 = await turn(agent, "hello there");
			(
				agent as unknown as { runtimeParams: { appendedContext: string[] } }
			).runtimeParams.appendedContext.push("SENTINEL_3222_prefer_bun");
			tools.setRuntimeParams({ voiceChatActive: true });
			try {
				const t2 = await turn(agent, "and again");
				expect(system(t2)).toBe(system(t1));
				expect(bytes(t2.messages.slice(0, t1.messages.length))).toBe(bytes(t1.messages));
				const tail = bytes(t2.messages.slice(t1.messages.length));
				expect(tail).toContain("SENTINEL_3222_prefer_bun");
				expect(tail).toContain("Voice Chat Mode (active)");
			} finally {
				tools.setRuntimeParams({ voiceChatActive: false });
			}
		}, 60_000);
	});
}

describe("tool loading is append-only", () => {
	const names = (r: InstanceType<typeof ToolRegistry>) => Object.keys(r.getTools());

	test("discover_tools adds after the existing tools and never reorders them", async () => {
		const r = new ToolRegistry(false);
		const before = names(r);
		const discover = r.getTools().discover_tools as unknown as {
			execute: (a: { category: string }) => Promise<unknown>;
		};
		await discover.execute({ category: "git" });
		const after = names(r);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.length).toBeGreaterThan(before.length);
	});

	test("an external tool cannot redefine one already in the list", () => {
		const r = new ToolRegistry(false);
		const original = r.getTools().read_file;
		r.registerExternalTool("read_file", () => "shadow");
		expect(r.getTools().read_file).toBe(original);
		r.registerExternalTool("ext_new_tool", () => "x");
		expect(names(r).at(-1)).toBe("ext_new_tool");
	});
});
