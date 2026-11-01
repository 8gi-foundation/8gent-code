/**
 * Regression tests for the TUI session logger's tool_call preview.
 *
 * Fault (Rishi test pilot, 2026-09-28, ollama qwen3.8:27b-mlx, text-tools
 * path): a write_file call whose `content` was a ~2.1 KB multi-line Markdown
 * outline failed with `JSON Parse error: Unterminated string` and the file was
 * never written. The model output parsed fine. The throw came from
 * logToolStart, which built its preview as
 * `JSON.parse(JSON.stringify(args).slice(0, 2000))` - cutting serialized JSON
 * mid-string and re-parsing it. logToolStart runs inside the agent's
 * onToolStart callback, which fires BEFORE the executor, so the throw aborted
 * the tool call itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Same shape as the real payload: multi-line Markdown, em dashes, backticks,
// arrows and braces, serialized well past 2000 chars.
function outlineLike(): string {
	const slides: string[] = ["# Eight System One — Deck Outline (5 slides)", ""];
	for (let i = 1; i <= 5; i++) {
		slides.push(`## Slide ${i} — Topic number ${i}`);
		slides.push(
			"- The harness asks typed questions about a `state` string and gets probabilities back",
		);
		slides.push(
			"- Request/response shape: `{ state, questions[] }` -> `{ answers[], backend, model }`",
		);
		slides.push(
			"- `detectBackend()` tries llamacpp -> laya -> ollama and picks a model from the list",
		);
		slides.push(
			"- Verdicts: `allow` / `escalate` / `block`; any error or missing backend fails closed",
		);
		slides.push(
			"- `createDecider` memoises up to 256 requests so identical input gives identical output",
		);
		slides.push("");
	}
	return slides.join("\n");
}

let home: string;
const originalHome = process.env.HOME;
let logger: typeof import("./session-logger");

beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-session-logger-"));
	// SESSIONS_DIR is resolved from HOME at module load, so set it first.
	process.env.HOME = home;
	logger = await import("./session-logger");
});

afterAll(() => {
	process.env.HOME = originalHome;
	fs.rmSync(home, { recursive: true, force: true });
});

describe("previewToolArgs", () => {
	test("the real failure: truncating serialized JSON and re-parsing throws", () => {
		const args = { path: "deck/outline.md", content: outlineLike() };
		expect(JSON.stringify(args).length).toBeGreaterThan(2000);
		expect(() => JSON.parse(JSON.stringify(args).slice(0, 2000))).toThrow(/Unterminated string/);
	});

	test("never throws and keeps short fields intact", () => {
		const args = { path: "deck/outline.md", content: outlineLike() };
		const preview = logger.previewToolArgs(args) as { path: string; content: string };
		expect(preview.path).toBe("deck/outline.md");
		expect(preview.content.length).toBeLessThan(args.content.length);
		expect(preview.content.startsWith("# Eight System One — Deck Outline")).toBe(true);
		expect(preview.content).toContain("more chars]");
	});

	test("result is valid JSON that round-trips", () => {
		const preview = logger.previewToolArgs({
			content: outlineLike(),
			nested: { deep: outlineLike() },
		});
		expect(() => JSON.parse(JSON.stringify(preview))).not.toThrow();
	});

	test("leaves small args untouched", () => {
		const args = { path: "a.txt", count: 3, flag: true, list: ["x", "y"] };
		expect(logger.previewToolArgs(args)).toEqual(args);
	});

	test("tolerates undefined and circular args", () => {
		expect(logger.previewToolArgs(undefined)).toEqual({});
		const circ: Record<string, unknown> = { a: 1 };
		circ.self = circ;
		expect(() => logger.previewToolArgs(circ)).not.toThrow();
	});
});

describe("logToolStart", () => {
	test("logs a write_file call whose content is over 2000 chars without throwing", () => {
		logger.initSessionLogger("test-session", "qwen3.8:27b-mlx", "ollama");
		const args = { path: "deck/outline.md", content: outlineLike() };
		expect(() => logger.logToolStart("t1", "Chat", "write_file", "tt-1", args)).not.toThrow();
		logger.flushSession();

		const dir = path.join(home, ".8gent", "sessions");
		const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
		expect(file).toBeDefined();
		const lines = fs
			.readFileSync(path.join(dir, file as string), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const call = lines.find((l) => l.type === "tool_call");
		expect(call.toolCall.name).toBe("write_file");
		expect(call.toolCall.arguments.path).toBe("deck/outline.md");
	});
});

describe("step_start and step_finish timing", () => {
	function readEvents(id: string): Array<Record<string, any>> {
		logger.flushSession();
		const dir = path.join(home, ".8gent", "sessions");
		for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
			const lines = fs
				.readFileSync(path.join(dir, f), "utf-8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			if (lines[0]?.meta?.sessionId === id) return lines;
		}
		throw new Error(`no session file for ${id}`);
	}

	test("step_start precedes step_finish and durationMs is finish minus start", async () => {
		logger.initSessionLogger("timing-1", "qwen3.8:27b", "ollama");
		logger.logStepStart("t1", "Chat", 0, "ollama", "qwen3.8:27b");
		await new Promise((r) => setTimeout(r, 40));
		logger.logStep("t1", "Chat", 0, 12, "hello");
		const ev = readEvents("timing-1");
		const start = ev.find((e) => e.type === "step_start")!;
		const fin = ev.find((e) => e.type === "step_finish")!;
		expect(start).toBeDefined();
		expect(start.sequenceNumber).toBeLessThan(fin.sequenceNumber);
		expect(start.stepNumber).toBe(0);
		expect(start.provider).toBe("ollama");
		expect(start.model).toBe("qwen3.8:27b");
		expect(typeof start.timestamp).toBe("string");
		const measured = Date.parse(fin.timestamp) - Date.parse(start.timestamp);
		expect(fin.durationMs).toBe(measured);
		expect(fin.durationMs).toBeGreaterThanOrEqual(30);
	});

	test("step_finish records the split from an Ollama-style response", () => {
		// ollama.ts maps prompt_eval_count/eval_count to prompt/completion tokens.
		const r = { prompt_eval_count: 900, eval_count: 100 };
		logger.initSessionLogger("split-1", "m", "ollama");
		logger.logStep("t1", "Chat", 0, 1000, "x", {
			promptTokens: r.prompt_eval_count,
			completionTokens: r.eval_count,
		});
		const fin = readEvents("split-1").find((e) => e.type === "step_finish")!;
		expect([fin.promptTokens, fin.completionTokens, fin.totalTokens]).toEqual([900, 100, 1000]);
	});

	test("step_finish records the split from an OpenAI-style usage", () => {
		const u = { prompt_tokens: 40, completion_tokens: 8 };
		logger.initSessionLogger("split-2", "m", "openrouter");
		logger.logStep("t1", "Chat", 0, 48, "x", {
			promptTokens: u.prompt_tokens,
			completionTokens: u.completion_tokens,
		});
		const fin = readEvents("split-2").find((e) => e.type === "step_finish")!;
		expect([fin.promptTokens, fin.completionTokens, fin.totalTokens]).toEqual([40, 8, 48]);
	});

	test("step_finish split is null when the provider gave none; total unchanged", () => {
		logger.initSessionLogger("split-3", "m", "p");
		logger.logStep("t1", "Chat", 0, 77, "x", {
			promptTokens: Number.NaN,
			completionTokens: Number.NaN,
		});
		logger.logStep("t1", "Chat", 1, 5);
		const fins = readEvents("split-3").filter((e) => e.type === "step_finish");
		expect(fins.map((f) => [f.promptTokens, f.completionTokens, f.totalTokens])).toEqual([
			[null, null, 77],
			[null, null, 5],
		]);
	});

	test("step_finish with no step_start has no durationMs", () => {
		logger.initSessionLogger("timing-2", "m", "p");
		logger.logStep("t1", "Chat", 3, 1);
		const fin = readEvents("timing-2").find((e) => e.type === "step_finish")!;
		expect(fin.durationMs).toBeUndefined();
	});

	test("step_start carries only index, provider, model, timestamp and tab ids", () => {
		logger.initSessionLogger("timing-3", "m", "p");
		logger.logStepStart("t1", "Chat", 1, "ollama", "qwen");
		const start = readEvents("timing-3").find((e) => e.type === "step_start")!;
		expect(Object.keys(start).sort()).toEqual(
			[
				"model",
				"provider",
				"sequenceNumber",
				"stepNumber",
				"tabId",
				"tabName",
				"timestamp",
				"type",
			].sort(),
		);
	});

	test("secret text passed as a user message or tool arg never lands in step_start", () => {
		const secret = "sk-SECRET-do-not-log-0123456789";
		logger.initSessionLogger("timing-4", "m", "p");
		logger.logMessage("t1", "Chat", "user", `my key is ${secret}`);
		logger.logToolStart("t1", "Chat", "write_file", "c1", { content: secret });
		logger.logStepStart("t1", "Chat", 0, "ollama", "qwen");
		logger.logStep("t1", "Chat", 0, 5);
		const ev = readEvents("timing-4");
		for (const e of ev.filter((x) => x.type === "step_start" || x.type === "step_finish")) {
			expect(JSON.stringify(e)).not.toContain(secret);
		}
	});

	test("two tabs interleaving the same step number each get their own duration", async () => {
		logger.initSessionLogger("timing-5", "m", "p");
		logger.logStepStart("A", "A", 0, "ollama", "m");
		await new Promise((r) => setTimeout(r, 30));
		logger.logStepStart("B", "B", 0, "ollama", "m");
		await new Promise((r) => setTimeout(r, 30));
		logger.logStep("A", "A", 0, 1);
		await new Promise((r) => setTimeout(r, 30));
		logger.logStep("B", "B", 0, 1);
		const ev = readEvents("timing-5");
		const starts = Object.fromEntries(
			ev.filter((e) => e.type === "step_start").map((e) => [e.tabId, e]),
		);
		const fins = Object.fromEntries(
			ev.filter((e) => e.type === "step_finish").map((e) => [e.tabId, e]),
		);
		for (const t of ["A", "B"]) {
			expect(fins[t].durationMs).toBe(
				Date.parse(fins[t].timestamp) - Date.parse(starts[t].timestamp),
			);
		}
		expect(fins.A.durationMs).toBeGreaterThan(fins.B.durationMs - 31);
		expect(fins.B.durationMs).toBeGreaterThanOrEqual(55);
	});

	test("step_finish stores textLength and never the model text", () => {
		logger.initSessionLogger("timing-6", "m", "p");
		logger.logStep("t1", "Chat", 0, 1, "reply with sk-MODEL-ECHO-123");
		const fin = readEvents("timing-6").find((e) => e.type === "step_finish")!;
		expect(fin.text).toBeUndefined();
		expect(fin.textLength).toBe("reply with sk-MODEL-ECHO-123".length);
		expect(JSON.stringify(fin)).not.toContain("sk-MODEL-ECHO-123");
	});
});
