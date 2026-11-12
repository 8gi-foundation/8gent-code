/**
 * Prefill meter (#3655): with EIGHT_PREFIX_METER=1 every model request lands in
 * the session jsonl as one model_round line; unset, nothing new is written.
 * The endpoint is a stubbed fetch; buildTextToolCall and SessionWriter run for real.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRoundEntry } from "../specifications/session/index";
import { SessionWriter } from "../specifications/session/writer";
import { parseRounds, totals } from "./prefill-report";
import { _resetQwenVariantCache, buildTextToolCall, FIRST_REPLY_LOG_MAX_BYTES, firstReplyLog, prefixMeterSink } from "./text-tool-endpoint";

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
	globalThis.fetch = realFetch;
	_resetQwenVariantCache();
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const MESSAGES = [
	{ role: "system" as const, content: "sys" },
	{ role: "user" as const, content: "fix the tests" },
];

function session(env: Record<string, string | undefined>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefill-meter-"));
	dirs.push(dir);
	const writer = new SessionWriter("session_meter", dir);
	const read = () => parseRounds(fs.readFileSync(writer.getFilePath(), "utf8"));
	return { onRound: prefixMeterSink(writer, env), read };
}

function stubChat(): void {
	globalThis.fetch = (async () =>
		Response.json({
			choices: [{ message: { content: "done" } }],
			usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 },
		})) as unknown as typeof fetch;
}

describe("prefill meter (#3655)", () => {
	it("flag unset: no sink and no model_round lines", async () => {
		stubChat();
		const s = session({});
		expect(s.onRound).toBeUndefined();
		const call = buildTextToolCall({ provider: "ollama", model: "m", onRound: s.onRound });
		expect(await call(MESSAGES)).toBe("done");
		expect(s.read()).toEqual([]);
	});

	it("flag on: one line per request with the provider's counts and the history length", async () => {
		stubChat();
		const s = session({ EIGHT_PREFIX_METER: "1" });
		const call = buildTextToolCall({ provider: "ollama", model: "m", onRound: s.onRound });
		await call(MESSAGES);
		await call(MESSAGES);
		const rounds = s.read();
		expect(rounds.map((r) => r.round)).toEqual([0, 1]);
		expect(rounds[0]).toMatchObject({
			type: "model_round",
			path: "chat",
			promptChars: 16,
			promptTokens: 1200,
			completionTokens: 30,
		});
		expect(rounds[0].wallMs).toBeGreaterThanOrEqual(rounds[0].headersMs);
		expect(rounds[0].promptEvalMs).toBeUndefined();
	});

	it("raw path: Ollama's nanosecond durations are recorded in ms", async () => {
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/api/show")) return Response.json({ modelfile: "RENDERER qwen3.8\n" });
			if (url.endsWith("/api/generate")) {
				return Response.json({
					response: "ok\n</think>\n\nanswer",
					done: true,
					prompt_eval_count: 900,
					eval_count: 40,
					prompt_eval_duration: 6_500_000_000,
					eval_duration: 2_000_000_000,
				});
			}
			// Ollama's built-in parser rejecting the reply sends the call down the raw path.
			return new Response(JSON.stringify({ error: { message: "EOF", type: "api_error" } }), {
				status: 500,
			});
		}) as unknown as typeof fetch;
		const s = session({ EIGHT_PREFIX_METER: "1" });
		const call = buildTextToolCall({ provider: "ollama", model: "q", onRound: s.onRound });
		expect(await call(MESSAGES)).toBe("answer");
		const raw = s.read().find((r) => r.path === "raw");
		expect(raw).toMatchObject({
			promptTokens: 900,
			completionTokens: 40,
			promptEvalMs: 6500,
			evalMs: 2000,
		});
	});
});

describe("prefill report totals", () => {
	const row = (r: Partial<ModelRoundEntry>): ModelRoundEntry => ({
		type: "model_round",
		timestamp: "t",
		sequenceNumber: 0,
		round: 0,
		path: "chat",
		promptChars: 0,
		promptTokens: null,
		completionTokens: null,
		headersMs: 0,
		wallMs: 0,
		...r,
	});

	it("sums provider durations, and estimates prefill from headers when none are reported", () => {
		const jsonl = [
			JSON.stringify(
				row({
					path: "raw",
					promptTokens: 900,
					completionTokens: 40,
					promptEvalMs: 6500,
					evalMs: 2000,
					headersMs: 6600,
					wallMs: 8600,
				}),
			),
			'{"type":"tool_call","stepNumber":0}',
			JSON.stringify(
				row({
					round: 1,
					promptTokens: 1200,
					completionTokens: 30,
					headersMs: 9000,
					wallMs: 10_500,
				}),
			),
			"not json",
		].join("\n");
		const rounds = parseRounds(jsonl);
		expect(rounds).toHaveLength(2);
		expect(totals(rounds)).toEqual({
			rounds: 2,
			prefillTokens: 2100,
			genTokens: 70,
			prefillMs: 15_500,
			genMs: 3500,
			estimated: 1,
		});
	});
});

describe("first reply log (#229 step 1)", () => {
	it("writes one line for the first request only, with no prompt text", async () => {
		stubChat();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-reply-"));
		dirs.push(dir);
		const file = path.join(dir, "logs", "prefill-times.jsonl");
		const call = buildTextToolCall({ provider: "ollama", model: "m", onRound: firstReplyLog("m", file) });
		await call(MESSAGES);
		await call(MESSAGES);
		const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ model: "m", promptTokens: 1200 });
		expect(lines[0].firstReplyMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(lines[0])).not.toContain("fix the tests");
	});

	it("an unwritable path never breaks the reply", async () => {
		stubChat();
		const call = buildTextToolCall({ provider: "ollama", model: "m", onRound: firstReplyLog("m", "/dev/null/x/y.jsonl") });
		expect(await call(MESSAGES)).toBe("done");
	});
});

describe("first reply log hardening", () => {
	const round = { path: "chat" as const, promptChars: 1, promptTokens: 5, completionTokens: 1, headersMs: 7, wallMs: 9 };
	function logFile() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-reply-"));
		dirs.push(dir);
		return path.join(dir, "logs", "prefill-times.jsonl");
	}

	it("creates the file 0600 and the directory 0700", () => {
		const f = logFile();
		firstReplyLog("m", f)(round);
		expect(fs.statSync(f).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
	});

	it("tightens a file that already existed with wider rights", () => {
		const f = logFile();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, "", { mode: 0o644 });
		firstReplyLog("m", f)(round);
		expect(fs.statSync(f).mode & 0o777).toBe(0o600);
	});

	it("does not write through a symlink", () => {
		const f = logFile();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		const target = path.join(path.dirname(f), "elsewhere");
		fs.writeFileSync(target, "");
		fs.symlinkSync(target, f);
		firstReplyLog("m", f)(round);
		expect(fs.readFileSync(target, "utf8")).toBe("");
	});

	it("stops writing once the file is over 1 MB", () => {
		const f = logFile();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, "x".repeat(FIRST_REPLY_LOG_MAX_BYTES + 1), { mode: 0o600 });
		firstReplyLog("m", f)(round);
		expect(fs.statSync(f).size).toBe(FIRST_REPLY_LOG_MAX_BYTES + 1);
	});

	it("a shared once writes one line for a turn even across a reroute", () => {
		const f = logFile();
		const once = { done: false };
		firstReplyLog("a", f, once)(round);
		firstReplyLog("b", f, once)(round);
		expect(fs.readFileSync(f, "utf8").trim().split("\n")).toHaveLength(1);
	});
});
