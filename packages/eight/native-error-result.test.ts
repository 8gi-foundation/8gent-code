/**
 * #150: on the native tool path a tool result that starts with the ERR: marker is a
 * failure for every consumer of the outcome, the same as in the honesty ledger. A real
 * success whose output only contains ERR: later in the text stays a success. Drives chat()
 * against a fake OpenAI-compatible endpoint, like done-gate-agent.test.ts; $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;
let enableInfiniteMode: () => void;
let disableInfiniteMode: () => void;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
let command = "";
let callId = "";
let seq = 0;

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
	home = mkdtempSync(join(tmpdir(), "native150-home-"));
	repo = mkdtempSync(join(tmpdir(), "native150-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	// run_command must really run: whether echo is auto-allowed depends on permission state
	// other test files in the same process can change, so pin it here.
	({ enableInfiniteMode, disableInfiniteMode } = await import("../permissions"));
	enableInfiniteMode();
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			calls++;
			if (calls === 1) {
				return completion(
					{
						content: null,
						tool_calls: [
							{
								id: callId,
								type: "function",
								function: { name: "run_command", arguments: JSON.stringify({ command }) },
							},
						],
					},
					"tool_calls",
				);
			}
			return completion({ content: "Ran it." }, "stop");
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	calls = 0;
});

afterAll(() => {
	disableInfiniteMode?.();
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	rmRetry(home);
	rmRetry(repo);
});

async function run(cmd: string) {
	command = cmd;
	callId = `call_${++seq}`;
	const ends: Array<{ toolName: string; success: boolean; resultPreview?: string }> = [];
	const agent = new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		events: { onToolEnd: (e: (typeof ends)[number]) => ends.push(e) },
	} as ConstructorParameters<typeof Agent>[0]);
	const hooks = (await import("../hooks")).getHookManager();
	const post: Array<{ success: boolean; result: string }> = [];
	const spy = spyOn(hooks, "fire").mockImplementation((async (type: string, ctx: any) => {
		if (type === "PostToolUse" && ctx?.tool === "run_command")
			post.push({ success: ctx.success, result: String(ctx.result) });
		return [];
	}) as never);
	try {
		await agent.chat("Run the command and report what it printed.");
	} finally {
		spy.mockRestore();
	}
	const dir = join(home, ".8gent", "sessions");
	const lines = readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
		.map((l) => JSON.parse(l) as Record<string, any>);
	const recorded = lines.filter(
		(l) => (l.type === "tool_result" || l.type === "tool_error") && l.toolCallId === callId,
	);
	const shown = ends.filter((e) => e.toolName === "run_command");
	// The command must have run: a permission refusal would make the checks below say nothing.
	expect(shown).toHaveLength(1);
	expect(shown[0].resultPreview ?? "").toContain("_");
	expect(shown[0].resultPreview ?? "").not.toContain("PERMISSION DENIED");
	return { ends: shown, post, recorded };
}

describe("native path outcome (#150)", () => {
	test("an ERR: result is a failure in the session file, onToolEnd and PostToolUse; the model text is unchanged", async () => {
		const r = await run("echo ERR:_session_is_not_running");
		expect(r.ends).toHaveLength(1);
		expect(r.ends[0].success).toBe(false);
		expect(r.ends[0].resultPreview).toContain("ERR:_session_is_not_running");
		expect(r.post).toHaveLength(1);
		expect(r.post[0].success).toBe(false);
		expect(r.post[0].result).toContain("ERR:_session_is_not_running");
		expect(r.recorded).toHaveLength(1);
		expect(r.recorded[0].type === "tool_error" || r.recorded[0].success === false).toBe(true);
		expect(r.recorded[0].success === true).toBe(false);
	}, 60_000);

	test("a real success that only contains ERR: later stays a success", async () => {
		const r = await run("echo ok_the_log_had_ERR:_retry");
		expect(r.ends[0].success).toBe(true);
		expect(r.post[0].success).toBe(true);
		expect(r.recorded[0].type).toBe("tool_result");
		expect(r.recorded[0].success).toBe(true);
	}, 60_000);
});
