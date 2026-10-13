/**
 * #4172: a headless run the harness stopped is a failure with its reason.
 *
 * - The circuit breaker (the "limit of 50 tool calls" stop) ends `8gent run` with a result
 *   of subtype "error", a `stop` naming the breaker, and a non-zero exit, never "ok" and 0.
 * - The session watchdog is logged and kept as a watchdog abort with the limit that fired,
 *   never as "Generation aborted by user".
 *
 * Fake model server only; no real model is loaded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";
import { validateRunEvent } from "./run-events";

type Mode = "tool-calls" | "native" | "hang";
let mode: Mode = "tool-calls";
let callNo = 0;
const saved: Record<string, string | undefined> = {};
let home: string;
let work: string;
let server: ReturnType<typeof Bun.serve>;

/** Ten distinct list_files calls per reply, so only the global limit can trip. */
function toolCallReply(): string {
	const blocks: string[] = [];
	for (let i = 0; i < 10; i++) {
		callNo++;
		blocks.push(
			`\`\`\`tool_call\n${JSON.stringify({ name: "list_files", arguments: { path: ".", pattern: `f${callNo}*` } })}\n\`\`\``,
		);
	}
	return blocks.join("\n");
}

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "run-stop-home-"));
	work = mkdtempSync(join(tmpdir(), "run-stop-work-"));
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
		idleTimeout: 30,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			if (mode === "native") {
				const tool_calls = Array.from({ length: 10 }, () => {
					callNo++;
					return {
						id: `call_${callNo}`,
						type: "function",
						function: {
							name: "list_files",
							arguments: JSON.stringify({ path: ".", pattern: `f${callNo}*` }),
						},
					};
				});
				return Response.json({
					id: "c1",
					object: "chat.completion",
					created: 0,
					model: "m",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: null, tool_calls },
							finish_reason: "tool_calls",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			}
			if (mode === "hang") {
				// Longer than the watchdog limit under test; the abort ends the request first.
				await new Promise((r) => setTimeout(r, 5_000));
			}
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: toolCallReply() },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
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

async function runStreamJson(): Promise<{ code: number; lines: Record<string, unknown>[] }> {
	const { runRunCommand } = await import("./run");
	const out: string[] = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((c: string | Uint8Array) => {
		out.push(String(c));
		return true;
	}) as typeof process.stdout.write;
	let code: number;
	try {
		code = await runRunCommand([
			"--yes",
			"--output-format",
			"stream-json",
			"--provider",
			"ollama",
			"--model",
			"m",
			"--cwd",
			work,
			"--max-turns",
			"60",
			"--no-session",
			"Make a narrated video deck.",
		]);
	} finally {
		process.stdout.write = realWrite;
	}
	const lines = out
		.join("")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
	return { code, lines };
}

describe("8gent run stopped by the circuit breaker (#4172)", () => {
	test("reports subtype error with the breaker's reason and exits non-zero", async () => {
		mode = "tool-calls";
		callNo = 0;
		const { code, lines } = await runStreamJson();
		for (const l of lines) expect(validateRunEvent(l)).toEqual([]);
		const result = lines.at(-1) as Record<string, unknown>;
		expect(result.type).toBe("result");
		expect(result.subtype).toBe("error");
		expect(String(result.error)).toContain("Global tool call limit exceeded");
		expect(String(result.error)).toContain("(limit: 50)");
		expect(result.stop).toEqual({ kind: "circuit_breaker", reason: String(result.error) });
		// The model's own words still reach the caller, alongside the failure.
		expect(String(result.final_text)).toContain("the task is not finished");
		expect(code).not.toBe(0);
	}, 60_000);

	test("the native tool path reports the same failure", async () => {
		mode = "native";
		callNo = 0;
		process.env.EIGHT_TEXT_TOOLS = "0";
		try {
			const { code, lines } = await runStreamJson();
			for (const l of lines) expect(validateRunEvent(l)).toEqual([]);
			const result = lines.at(-1) as Record<string, unknown>;
			expect(result.type).toBe("result");
			expect(result.subtype).toBe("error");
			expect(String(result.error)).toContain("Global tool call limit exceeded");
			expect((result.stop as { kind?: string } | undefined)?.kind).toBe("circuit_breaker");
			expect(code).not.toBe(0);
		} finally {
			process.env.EIGHT_TEXT_TOOLS = "1";
		}
	}, 60_000);
});

describe("session watchdog abort (#4172)", () => {
	test("is logged and kept as a watchdog abort with its limit, not as the person's ESC", async () => {
		mode = "hang";
		const { Agent } = await import("./agent");
		const agent = new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: work,
			maxTurns: 5,
			headless: true,
			maxSessionMs: 300,
		} as ConstructorParameters<typeof Agent>[0]);
		const logged: string[] = [];
		const realLog = console.log;
		console.log = (...a: unknown[]) => {
			logged.push(a.map(String).join(" "));
		};
		try {
			await agent.chat("Make a narrated video deck.").catch(() => undefined);
		} finally {
			console.log = realLog;
		}
		const stop = agent.getTurnStop();
		expect(stop?.kind).toBe("watchdog");
		expect(stop?.kind === "watchdog" ? stop.limitMs : null).toBe(300);
		const all = logged.join("\n");
		expect(all).toContain("Session watchdog abort");
		expect(all).toContain("limit of 300 ms");
		expect(all).not.toContain("aborted by user");
		await agent.cleanup();
	}, 30_000);

	test("the result event carries the watchdog's limit and validates", async () => {
		const { stopInfo } = await import("./run");
		const { watchdogStop } = await import("./agent");
		const info = stopInfo(watchdogStop(1_800_000));
		expect(info).toEqual({
			kind: "watchdog",
			reason: "Session watchdog abort: the turn ran past its limit of 1800000 ms (30 min).",
			limit_ms: 1_800_000,
		});
		const event = {
			type: "result",
			subtype: "error",
			session_id: "s",
			ended_at: "t",
			error: info.reason,
			stop: info,
		};
		expect(validateRunEvent(event)).toEqual([]);
		// A stop on an "ok" result is a contradiction the validator rejects.
		expect(validateRunEvent({ ...event, subtype: "ok" })).toEqual(["stop"]);
	});
});
