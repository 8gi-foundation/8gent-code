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
import { createEightAgent } from "./agent";
import { getToolContext, setToolContext } from "./tools";

type Call = { name: string; args: Record<string, unknown> };

const servers: { stop: (force?: boolean) => void }[] = [];
const dirs: string[] = [];

afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

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
					choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
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

function agentFor(workingDirectory: string, agentId: string, call: Call) {
	const model = scriptedModel(call);
	const agent = createEightAgent({
		provider: { name: "ollama", model: "fake", baseURL: model.baseURL },
		workingDirectory,
		agentId,
		maxSteps: 3,
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
		expect(await run(a)).toContain(dirA);
		expect(await run(b)).toContain(dirB);
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
