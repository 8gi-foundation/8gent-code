/**
 * A failed local text-tool turn must (1) say what actually went wrong and
 * (2) leave a runs.jsonl record.
 *
 * Before this, a model that was merely slow was reported as "is not reachable.
 * Is LM Studio or Ollama running?" because the reachability check matched
 * "timed out", and the catch returned before appendRun so the failed turn left
 * no trace in ~/.8gent/runs.jsonl.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildTextToolCall } from "../ai/text-tool-endpoint";
import {
	classifyLocalTurnError,
	describeLocalTurnFailure,
	failedTurnRunEntry,
} from "./local-turn-error";
import { TurnTimeoutError } from "./turn-timeout";

const ENDPOINT = "http://localhost:11434/v1/chat/completions";

describe("classifyLocalTurnError", () => {
	it("our own turn timeout is a timeout", () => {
		expect(classifyLocalTurnError(new TurnTimeoutError(300_000, "ollama/m"))).toBe("timeout");
	});

	it("Bun's fetch TimeoutError ('The operation timed out.') is a timeout", () => {
		const err = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
		expect(classifyLocalTurnError(err)).toBe("timeout");
	});

	it("a bare 'timed out' message is a timeout, not a reachability failure", () => {
		expect(classifyLocalTurnError(new Error("request timed out"))).toBe("timeout");
	});

	it("ECONNREFUSED is unreachable", () => {
		const err = Object.assign(
			new Error("Unable to connect. Is the computer able to access the url?"),
			{
				code: "ECONNREFUSED",
			},
		);
		expect(classifyLocalTurnError(err)).toBe("unreachable");
		expect(classifyLocalTurnError(new Error("connect ECONNREFUSED 127.0.0.1:11434"))).toBe(
			"unreachable",
		);
	});

	it("ENOTFOUND is unreachable", () => {
		expect(classifyLocalTurnError(new Error("getaddrinfo ENOTFOUND no-such-host"))).toBe(
			"unreachable",
		);
	});

	it("'fetch failed' is unreachable", () => {
		expect(classifyLocalTurnError(new TypeError("fetch failed"))).toBe("unreachable");
	});

	it("anything else is other", () => {
		expect(classifyLocalTurnError(new Error("ollama chat completions 500: boom"))).toBe("other");
	});
});

describe("describeLocalTurnFailure", () => {
	it("a timeout names the limit in seconds and the env var that raises it", () => {
		const out = describeLocalTurnFailure(new TurnTimeoutError(300_000, "ollama/m"), {
			endpoint: ENDPOINT,
			timeoutMs: 300_000,
		});
		expect(out.kind).toBe("timeout");
		expect(out.message).toContain("took longer than 300 seconds");
		expect(out.message).toContain("EIGHT_TURN_TIMEOUT_MS");
		expect(out.message).not.toContain("not reachable");
		expect(out.message).not.toContain("Is LM Studio or Ollama running");
		expect(out.reason).toContain("timeout");
	});

	it("a timeout with no timeoutMs on the error falls back to the configured limit", () => {
		const err = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
		const out = describeLocalTurnFailure(err, { endpoint: ENDPOINT, timeoutMs: 600_000 });
		expect(out.message).toContain("took longer than 600 seconds");
	});

	it("an unreachable endpoint keeps the 'is it running?' hint", () => {
		const out = describeLocalTurnFailure(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
			endpoint: ENDPOINT,
			timeoutMs: 300_000,
		});
		expect(out.kind).toBe("unreachable");
		expect(out.message).toContain(`(${ENDPOINT}) is not reachable`);
		expect(out.message).toContain("Is LM Studio or Ollama running?");
	});

	it("any other failure reports the raw cause", () => {
		const out = describeLocalTurnFailure(new Error("ollama chat completions 500: boom"), {
			endpoint: ENDPOINT,
			timeoutMs: 300_000,
		});
		expect(out.kind).toBe("other");
		expect(out.message).toBe(
			"The local model turn could not complete: ollama chat completions 500: boom",
		);
	});
});

describe("failedTurnRunEntry", () => {
	it("builds an error record with the reason", () => {
		const entry = failedTurnRunEntry({
			model: "qwen3:14b",
			startedAt: 1_000,
			now: 301_000,
			tokens: 12,
			cost: null,
			tools: 2,
			created: ["a.ts"],
			modified: [],
			session: "s1",
			cwd: "/tmp/x",
			prompt: "x".repeat(500),
			reason: "timeout: took longer than 300 seconds",
		});
		expect(entry.status).toBe("error");
		expect(entry.error).toBe("timeout: took longer than 300 seconds");
		expect(entry.dur).toBe(300);
		expect(entry.model).toBe("qwen3:14b");
		expect(entry.tools).toBe(2);
		expect(entry.prompt.length).toBe(120);
		expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
	});
});

describe("real path: slow local server -> timeout message", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;
	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			async fetch() {
				await Bun.sleep(2_000);
				return Response.json({ choices: [{ message: { content: "late" } }] });
			},
		});
	});
	afterAll(() => server?.stop(true));

	it("a model that is slow (not down) is reported as a timeout", async () => {
		const endpoint = `http://127.0.0.1:${server?.port}/v1/chat/completions`;
		const call = buildTextToolCall({ provider: "ollama", model: "m", endpoint, timeoutMs: 150 });
		const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
		const out = describeLocalTurnFailure(err, { endpoint, timeoutMs: 150 });
		expect(out.kind).toBe("timeout");
		expect(out.message).toContain("EIGHT_TURN_TIMEOUT_MS");
	});

	it("a closed port is reported as unreachable", async () => {
		const endpoint = "http://127.0.0.1:1/v1/chat/completions";
		const call = buildTextToolCall({ provider: "ollama", model: "m", endpoint, timeoutMs: 5_000 });
		const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
		const out = describeLocalTurnFailure(err, { endpoint, timeoutMs: 5_000 });
		expect(out.kind).toBe("unreachable");
	});
});
