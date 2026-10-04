/**
 * #3502 batch trial: the user sees skipped calls in the TUI.
 *
 * Drives the shipping Agent.chat() text-tool path against a fake
 * OpenAI-compatible endpoint. The model replies with three calls; the first
 * (edit_file on a file that does not exist) fails. With EIGHT_RUN_BATCH=1 the
 * other two never run and one "skipped_calls" tool event pair reaches the
 * onToolStart / onToolEnd callbacks the TUI already renders. With the flag
 * off, all three run and no such event fires. $HOME is faked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let Agent: typeof import("./agent").Agent;

type Msg = { role: string; content: unknown };
type Body = { messages: Msg[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;

const call = (name: string, args: Record<string, unknown>) =>
	["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");

const BATCH = [
	call("edit_file", { path: "missing.ts", oldText: "a", newText: "b" }),
	call("write_file", { path: "created.txt", content: "should not exist under the flag" }),
	call("read_file", { path: "created.txt" }),
].join("\n");

function reply(content: string) {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "batch3502-home-"));
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
			const body = (await req.json()) as Body;
			// After the tool round the results come back as a user message.
			const sawResults = body.messages.some(
				(m) => m.role === "user" && JSON.stringify(m.content).includes("returned:"),
			);
			return reply(sawResults ? "DONE: the edit failed, nothing else was changed." : BATCH);
		},
	});
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
});

type Ev = { toolName: string; success?: boolean; resultPreview?: string };

async function runTurn(flag: string | undefined) {
	if (flag === undefined) delete process.env.EIGHT_RUN_BATCH;
	else process.env.EIGHT_RUN_BATCH = flag;
	repo = mkdtempSync(join(tmpdir(), "batch3502-repo-"));
	const starts: Ev[] = [];
	const ends: Ev[] = [];
	try {
		const agent = new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
			events: {
				onToolStart: (e: Ev) => starts.push(e),
				onToolEnd: (e: Ev) => ends.push(e),
			},
		} as ConstructorParameters<typeof Agent>[0]);
		await agent.chat(
			"Edit missing.ts to replace a with b, then write created.txt and read it back.",
		);
		return { starts, ends, created: existsSync(join(repo, "created.txt")) };
	} finally {
		delete process.env.EIGHT_RUN_BATCH;
		rmSync(repo, { recursive: true, force: true });
	}
}

describe("batch trial skip event on the shipping text-tool path (#3502)", () => {
	test("flag on: the two calls after the failed edit never run and one skipped_calls line reaches the TUI events", async () => {
		const { starts, ends, created } = await runTurn("1");
		expect(created).toBe(false);
		expect(starts.map((e) => e.toolName)).toEqual(["edit_file", "skipped_calls"]);
		const skip = ends.filter((e) => e.toolName === "skipped_calls");
		expect(skip).toHaveLength(1);
		expect(skip[0].success).toBe(false);
		expect(skip[0].resultPreview).toBe("Skipped 2 calls after the failed edit_file");
	}, 60_000);

	test("flag off: all three calls run and no skipped_calls event fires", async () => {
		const { starts, ends, created } = await runTurn(undefined);
		expect(created).toBe(true);
		expect(starts.map((e) => e.toolName)).toEqual(["edit_file", "write_file", "read_file"]);
		expect(ends.some((e) => e.toolName === "skipped_calls")).toBe(false);
	}, 60_000);
});
