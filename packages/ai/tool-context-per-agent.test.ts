/**
 * The native tool context is per agent, not per process (#3127).
 *
 * Before this fix packages/ai/tools.ts held one module-level ToolContext that
 * every Agent constructor and every createEightAgent() overwrote, so building
 * a second agent in the same process (a spawned sub-agent, a Table session, a
 * second TUI tab) moved the first agent's working directory and write scope.
 *
 * These tests drive the real AI SDK tool loop: createEightAgent() talks to a
 * local OpenAI-compatible endpoint that answers with one scripted tool call,
 * so the tool runs exactly as it does in a live turn. Agent B is always built
 * after agent A, which is the order that broke A.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeTree } from "../../tests/db-files";
import { type EightAgentConfig, createEightAgent } from "./agent";
import { agentTools, createRuntimeParams, getToolContext, setToolContext } from "./tools";

type Call = { name: string; args: Record<string, unknown> };

// Memory tests open a global store: keep it off the real ~/.8gent.
process.env.EIGHT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "toolctx-data-"));

const servers: { stop: (force?: boolean) => void }[] = [];
const dirs: string[] = [];

afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const d of dirs) removeTree(d);
	removeTree(process.env.EIGHT_DATA_DIR as string);
});

/**
 * How `pwd` prints a directory. POSIX: the path itself. Windows: the shell is
 * Git Bash, which prints an MSYS path (/tmp/...) for the same directory, so
 * match the unique final component, which still tells A's directory from B's.
 */
function shown(dir: string): string {
	return process.platform === "win32" ? path.basename(dir) : dir;
}

function tempDir(label: string): string {
	// realpath: /tmp is a symlink on macOS and `pwd` prints the resolved path.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolctx-${label}-`)));
	dirs.push(dir);
	return dir;
}

/**
 * A chat-completions endpoint that asks for `call` once, then finishes. The
 * tool's result comes back in the second request, which is how the test reads
 * what the tool actually did.
 */
function scriptedModel(call: Call): { baseURL: string; toolResults: string[] } {
	const toolResults: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { messages: { role: string; content: unknown }[] };
			const toolMsg = body.messages.find((m) => m.role === "tool");
			const base = { id: "c", object: "chat.completion", created: 0, model: "fake" };
			const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
			if (toolMsg) {
				toolResults.push(
					typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content),
				);
				return Response.json({
					...base,
					choices: [
						{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
					],
					usage,
				});
			}
			return Response.json({
				...base,
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: { name: call.name, arguments: JSON.stringify(call.args) },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage,
			});
		},
	});
	servers.push(server);
	return { baseURL: `http://127.0.0.1:${server.port}`, toolResults };
}

function agentFor(
	workingDirectory: string,
	agentId: string,
	call: Call,
	extra: Partial<EightAgentConfig> = {},
) {
	const model = scriptedModel(call);
	const agent = createEightAgent({
		provider: { name: "ollama", model: "fake", baseURL: model.baseURL },
		workingDirectory,
		agentId,
		maxSteps: 3,
		...extra,
	});
	return { agent, toolResults: model.toolResults };
}

async function run(a: ReturnType<typeof agentFor>): Promise<string> {
	await a.agent.generate({ messages: [{ role: "user", content: "go" }] });
	expect(a.toolResults.length).toBe(1);
	return a.toolResults[0];
}

describe("two agents in one process keep their own tool context (#3127)", () => {
	test("run_command runs in each agent's own working directory", async () => {
		const dirA = tempDir("a");
		const dirB = tempDir("b");
		const a = agentFor(dirA, "primary", { name: "run_command", args: { command: "pwd" } });
		const b = agentFor(dirB, "primary", { name: "run_command", args: { command: "pwd" } });

		// A runs after B was built: the order that used to hand A B's directory.
		expect(await run(a)).toContain(shown(dirA));
		expect(await run(b)).toContain(shown(dirB));
	});

	test("write_file resolves a relative path against each agent's own directory", async () => {
		const dirA = tempDir("wa");
		const dirB = tempDir("wb");
		const a = agentFor(dirA, "primary", {
			name: "write_file",
			args: { path: "note.txt", content: "from a" },
		});
		const b = agentFor(dirB, "primary", {
			name: "write_file",
			args: { path: "note.txt", content: "from b" },
		});

		await run(a);
		await run(b);
		expect(fs.readFileSync(path.join(dirA, "note.txt"), "utf8")).toBe("from a");
		expect(fs.readFileSync(path.join(dirB, "note.txt"), "utf8")).toBe("from b");
	});

	test("the write-policy gate sees each agent's own scope", async () => {
		const dirShadow = tempDir("shadow");
		const dirPrimary = tempDir("primary");
		// __shadow__ is hard-denied every write by the policy engine (#2699).
		const shadow = agentFor(dirShadow, "__shadow__", {
			name: "write_file",
			args: { path: "x.txt", content: "shadow" },
		});
		const primary = agentFor(dirPrimary, "primary", {
			name: "write_file",
			args: { path: "x.txt", content: "primary" },
		});

		// Built second, the primary agent must not lift the shadow agent's deny.
		const shadowOut = await run(shadow);
		expect(shadowOut).toContain("shadow-deny");
		expect(shadowOut).not.toContain("File written");
		expect(fs.existsSync(path.join(dirShadow, "x.txt"))).toBe(false);

		// And the shadow agent's deny must not leak onto the primary agent.
		await run(primary);
		expect(fs.readFileSync(path.join(dirPrimary, "x.txt"), "utf8")).toBe("primary");
	});

	test("building an agent never rewrites the process fallback context", () => {
		const saved = getToolContext();
		const fallback = tempDir("fallback");
		setToolContext({ workingDirectory: fallback, agentId: "primary" });
		try {
			agentFor(tempDir("x"), "__table__", { name: "run_command", args: { command: "pwd" } });
			expect(getToolContext()).toEqual({ workingDirectory: fallback, agentId: "primary" });
		} finally {
			setToolContext(saved);
		}
	});
});

// ── Runtime params and memory are per agent too (#3140) ─────────────────
// Before: one module-level RuntimeParams for the process, so self_tune on one
// agent changed another agent's next turn and self_inspect reported whichever
// agent wrote last; and one MemoryManager for the process, fixed to the first
// caller's directory, so a second agent's remember and recall used the first
// agent's project memory.

// The local-provider default trims tools to a core set; give these tests the
// self and memory tools explicitly.
const selfAndMemoryTools = {
	self_tune: agentTools.self_tune,
	self_inspect: agentTools.self_inspect,
	self_append_context: agentTools.self_append_context,
	remember: agentTools.remember,
	recall: agentTools.recall,
};

describe("two agents in one process keep their own runtime params (#3140)", () => {
	test("self_tune on one agent never reaches the other", async () => {
		const runtimeA = createRuntimeParams();
		const runtimeB = createRuntimeParams();
		const a = agentFor(
			tempDir("rta"),
			"primary",
			{ name: "self_tune", args: { parameter: "temperature", value: 0.1, reason: "test" } },
			{ tools: selfAndMemoryTools, runtime: runtimeA },
		);
		const b = agentFor(
			tempDir("rtb"),
			"primary",
			{ name: "self_inspect", args: {} },
			{ tools: selfAndMemoryTools, runtime: runtimeB },
		);

		await run(a);
		expect(runtimeA.temperature).toBe(0.1);
		expect(runtimeB.temperature).toBe(0.7);
		// B inspects itself after A tuned: it must see its own 0.7, not A's 0.1.
		expect(JSON.parse(await run(b)).tunable.temperature).toBe(0.7);
	});

	test("self_append_context stays on the agent that appended it", async () => {
		const runtimeA = createRuntimeParams();
		const runtimeB = createRuntimeParams();
		const a = agentFor(
			tempDir("apa"),
			"primary",
			{ name: "self_append_context", args: { context: "only for A", reason: "test" } },
			{ tools: selfAndMemoryTools, runtime: runtimeA },
		);
		agentFor(
			tempDir("apb"),
			"primary",
			{ name: "self_inspect", args: {} },
			{
				tools: selfAndMemoryTools,
				runtime: runtimeB,
			},
		);

		await run(a);
		expect(runtimeA.appendedContext).toEqual(["only for A"]);
		expect(runtimeB.appendedContext).toEqual([]);
		expect(createRuntimeParams().appendedContext).toEqual([]);
	});
});

describe("two agents in one process keep their own memory (#3140)", () => {
	test("remember on one agent is not recalled by an agent in another directory", async () => {
		const dirA = tempDir("mema");
		const dirB = tempDir("memb");
		const fact = "the orchestrator codename is bluefinch";
		const a = agentFor(
			dirA,
			"primary",
			{ name: "remember", args: { fact, layer: "session" } },
			{ tools: selfAndMemoryTools },
		);
		const b = agentFor(
			dirB,
			"primary",
			{ name: "recall", args: { query: "bluefinch" } },
			{ tools: selfAndMemoryTools },
		);
		const a2 = agentFor(
			dirA,
			"primary",
			{ name: "recall", args: { query: "bluefinch" } },
			{ tools: selfAndMemoryTools },
		);

		expect(JSON.parse(await run(a)).stored).toBe(true);
		// B works in another directory: A's memory is not its memory.
		expect(JSON.parse(await run(b)).count).toBe(0);
		// A, in its own directory, still finds it.
		expect(JSON.parse(await run(a2)).count).toBe(1);
	});
});
