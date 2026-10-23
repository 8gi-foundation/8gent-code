/**
 * Durable slice 3 (docs/specs/DURABLE-TURNS.md): `8gent -p --resume <id> --durable-retry`
 * never re-runs a command an interrupted turn left open, even with --yes and a
 * model that emits it anyway. Drives the real headless run and tool loop against
 * a fake model server; the control run shows the same call does run otherwise.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";
import { appendRecord, interruptedCalls } from "../specifications/session/durable-ledger";
import { retryAllowlist } from "../specifications/session/durable-verify";
import { readOnlyToolNames } from "./tool-registry";

type Body = { messages: Array<{ role: string; content: unknown }> };
const saved: Record<string, string | undefined> = {};
let home: string;
let work: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let emitTool = "run_command";

const reply = (content: string) =>
	Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "durable-retry-home-"));
	work = mkdtempSync(join(tmpdir(), "durable-retry-work-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	const env: Record<string, string> = {
		HOME: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
		EIGHT_TOOL_CAPABILITY_GATE: "0",
		"8GENT_TWO_STAGE_COMPACT": "0",
		EIGHT_TEXT_TOOLS: "1",
		EIGHT_DONE_GATE: "0",
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			bodies.push((await req.json()) as Body);
			// The first model call re-runs the command; every later call answers.
			if (bodies.length === 1) {
				const command = { command: "touch made.txt" };
				// background_start is a deferred tool: a run_batch item reaches it in one turn.
				const call =
					emitTool === "background_start"
						? { name: "run_batch", arguments: { items: [{ tool: emitTool, args: command }] } }
						: { name: emitTool, arguments: command };
				return reply(["```tool_call", JSON.stringify(call), "```"].join("\n"));
			}
			return reply("DONE: carried on.");
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
	(await import("./modes")).resetModeManager();
	await Bun.sleep(100); // a detached background_start finishes before the next test looks
	bodies = [];
	rmSync(join(work, "made.txt"), { force: true });
});

afterAll(() => {
	server?.stop(true);
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	removeDir(home);
	removeDir(work);
});

async function headless(args: string[]): Promise<{ code: number; err: string }> {
	const { runRunCommand } = await import("./run");
	const err: string[] = [];
	const realOut = process.stdout.write.bind(process.stdout);
	const realErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = ((c: string | Uint8Array) => {
		err.push(String(c));
		return true;
	}) as typeof process.stderr.write;
	let code: number;
	try {
		code = await runRunCommand(
			["-p", "--yes", "--provider", "ollama", "--model", "m", "--cwd", work, ...args],
			{ stdin: async () => "" },
		);
	} finally {
		process.stdout.write = realOut;
		process.stderr.write = realErr;
	}
	return { code, err: err.join("") };
}

/** A file the command leaves; background_start runs it detached, so allow it a moment. */
async function made(): Promise<boolean> {
	for (let i = 0; i < 40; i++) {
		if (existsSync(join(work, "made.txt"))) return true;
		await Bun.sleep(50);
	}
	return false;
}

// Controls: without a ledger these calls really run, so a refusal below is the gate's doing.
for (const tool of ["run_command", "background_start"]) {
	test(`control: with no ledger an emitted ${tool} runs`, async () => {
		emitTool = tool;
		if (tool === "background_start") process.env.EIGHT_RUN_BATCH = "1";
		try {
			const { code } = await headless(["carry on"]);
			expect(code).toBe(0);
			expect(await made()).toBe(true);
		} finally {
			Reflect.deleteProperty(process.env, "EIGHT_RUN_BATCH");
		}
	}, 60_000);
}

// A retry run is an allowlist: read-only tools plus the ones resume can verify.
for (const tool of ["run_command", "background_start", "term_spawn", "mcp_call_tool"]) {
	test(`--durable-retry refuses ${tool}, even with --yes and the model asking`, async () => {
		emitTool = tool;
		process.env.EIGHT_RUN_BATCH = "1";
		const key = `s-${tool}`;
		appendRecord(key, {
			k: "intent",
			id: "r1",
			tool: "run_command",
			argsHash: "0",
			key: `${key}:r1`,
			hint: "touch made.txt",
			at: new Date().toISOString(),
		});
		try {
			const { code, err } = await headless(["--resume", key, "--durable-retry", "carry on"]);
			expect(code).toBe(0);
			expect(err).toContain("this run may only read and use write_file, edit_file, git_commit");
			const allow = new Set(retryAllowlist(readOnlyToolNames()));
			const mm = (await import("./modes")).getModeManager();
			for (const t of [
				tool,
				"run_batch",
				"term_spawn",
				"term_send",
				"mcp_call_tool",
				"desktop_type",
			])
				expect(mm.isToolAllowed(t)).toBe(false);
			for (const t of allow) expect(mm.isToolAllowed(t)).toBe(true);
			// Offered: only allowlisted names reach the model's catalog.
			const offered = bodies[0].messages
				.filter((m) => m.role === "system")
				.flatMap((m) => String(m.content).split("\n"))
				.flatMap((l) => /^([a-z_]+)\(/.exec(l)?.[1] ?? []);
			expect(offered.length).toBeGreaterThan(0);
			for (const t of offered) expect(allow.has(t)).toBe(true);
			for (const t of ["write_file", "edit_file", "git_commit", "read_file"])
				expect(offered).toContain(t);
			// Refused before it ran: no file, and the model was told so.
			expect(await made()).toBe(false);
			const name = tool === "background_start" ? "run_batch" : tool;
			const later = JSON.stringify(bodies.slice(1).map((b) => b.messages));
			expect(later).toMatch(
				new RegExp(
					`no tool named \\\\"${name}\\\\" is available|${name} is not available in Durable retry mode`,
				),
			);
			expect(interruptedCalls(key)).toHaveLength(0);
		} finally {
			Reflect.deleteProperty(process.env, "EIGHT_RUN_BATCH");
		}
	}, 60_000);
}
