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
		slides.push("- The harness asks typed questions about a `state` string and gets probabilities back");
		slides.push("- Request/response shape: `{ state, questions[] }` -> `{ answers[], backend, model }`");
		slides.push("- `detectBackend()` tries llamacpp -> laya -> ollama and picks a model from the list");
		slides.push("- Verdicts: `allow` / `escalate` / `block`; any error or missing backend fails closed");
		slides.push("- `createDecider` memoises up to 256 requests so identical input gives identical output");
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
		const preview = logger.previewToolArgs({ content: outlineLike(), nested: { deep: outlineLike() } });
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
