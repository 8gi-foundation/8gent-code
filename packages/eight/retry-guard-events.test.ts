/**
 * A retry and a loop guard are told to the UI as they fire (#4955). Drives chat() against a fake
 * OpenAI-compatible endpoint; $HOME is faked.
 *   - native path: the first three model calls answer 429 (the SDK spends two retries on its own),
 *     then it succeeds: onRetry says rate limit, retry 1 of 3, with the wait.
 *   - text-tool path: the model asks for the same failing read three times: the circuit breaker
 *     stops the turn and onGuard says so in the agent's words.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { AgentGuardEvent, AgentRetryEvent } from "./types";

let Agent: typeof import("./agent").Agent;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let mode: "rate-limit" | "loop" = "rate-limit";
let calls = 0;

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
	home = mkdtempSync(join(tmpdir(), "retryguard-home-"));
	repo = mkdtempSync(join(tmpdir(), "retryguard-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	(await import("../hooks")).resetHookManager();
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			calls++;
			if (mode === "rate-limit") {
				// The AI SDK retries a 429 twice by itself, out of sight; the harness's own retry
				// (the one this event reports) only starts once those are used up.
				if (calls <= 3) {
					return Response.json(
						{ error: { message: "429 Too Many Requests: rate limit exceeded" } },
						{ status: 429 },
					);
				}
				return completion({ content: "DONE." }, "stop");
			}
			// loop: the same failing read, over and over, until the breaker stops the turn.
			if (calls <= 8) {
				const block = [
					"```tool_call",
					JSON.stringify({ name: "read_file", arguments: { path: join(repo, "nope.txt") } }),
					"```",
				];
				return completion({ content: block.join("\n") }, "stop");
			}
			return completion({ content: "DONE." }, "stop");
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	server?.stop(true);
	(await import("../hooks")).resetHookManager();
	(await import("../memory/index")).resetMemoryManager();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
	rmRetry(home);
	rmRetry(repo);
});

describe("retries are told to the UI", () => {
	test("native path: a 429 then success says rate limit, retry 1 of 3, and the wait", async () => {
		process.env.EIGHT_TEXT_TOOLS = "0";
		mode = "rate-limit";
		calls = 0;
		const retries: AgentRetryEvent[] = [];
		const agent = new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
			events: { onRetry: (e: AgentRetryEvent) => void retries.push(e) },
		} as ConstructorParameters<typeof Agent>[0]);
		await agent.chat("Say hi.");
		expect(retries.length).toBeGreaterThanOrEqual(1);
		const r = retries[0];
		expect(r.kind).toBe("rate_limit");
		expect(r.attempt).toBe(1);
		expect(r.max).toBe(3);
		expect(r.delayMs).toBe(2000);
		expect(String(r.cause)).toContain("429");
		expect(typeof r.provider).toBe("string");
		expect(r.model).toBe("m");
	}, 60_000);
});

describe("loop guards are told to the UI", () => {
	test("text-tool path: the same failing call three times stops the turn and onGuard says so", async () => {
		process.env.EIGHT_TEXT_TOOLS = "1";
		mode = "loop";
		calls = 0;
		const guards: AgentGuardEvent[] = [];
		const agent = new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
			events: { onGuard: (e: AgentGuardEvent) => void guards.push(e) },
		} as ConstructorParameters<typeof Agent>[0]);
		await agent.chat("Read nope.txt.").catch(() => {});
		const stop = guards.find((g) => g.kind === "circuit_breaker");
		expect(stop).toBeDefined();
		expect(stop?.reason).toMatch(/read_file call \d+ times in a row/);
	}, 60_000);
});
