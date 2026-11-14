/**
 * #1108 lane 5: a real Agent turn leaves one local run record. Drives the
 * shipping chat() against a fake Ollama on the text-tool path (a tool call,
 * then an answer) and reads the trace back from disk the way `8gent trace
 * show` does. $HOME is faked so the operator's data stays out of the test.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { ATTR, parseSpans, runTotals, traceCommand } from "../telemetry/run-trace";

let Agent: typeof import("./agent").Agent;

const PROMPT_MARK = "PROMPTMARK7f3a";
const FILE_MARK = "FILEMARK9c2e";
const ANSWER_MARK = "ANSWERMARK41bd";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let traces: string;
let server: ReturnType<typeof Bun.serve>;
/** Chat requests the fake model answered: the truth the trace is checked against. */
let completions = 0;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "trace-home-"));
	repo = mkdtempSync(join(tmpdir(), "trace-repo-"));
	traces = join(home, "traces");
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(join(repo, "notes.txt"), `the code word is ${FILE_MARK}\n`);
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	ENV.EIGHT_TRACE_DIR = traces;
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const pathname = new URL(req.url).pathname;
			if (pathname === "/api/tags") return Response.json({ models: [{ name: "tiny" }] });
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			if (pathname === "/api/show") return Response.json({ capabilities: ["completion", "tools"] });
			const body = (await req.json()) as { model: string; messages: Array<{ content: unknown }> };
			completions++;
			const sawTool = JSON.stringify(body.messages).includes(FILE_MARK);
			const content = sawTool
				? `DONE: the code word is ${FILE_MARK}. ${ANSWER_MARK}`
				: [
						"I will read the file.",
						"```tool_call",
						'{"name": "read_file", "arguments": {"path": "notes.txt"}}',
						"```",
					].join("\n");
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model,
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
	({ Agent } = await import("./agent"));
}, 30_000);

afterAll(() => {
	server?.stop(true);
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

test("one turn writes one run: model, tool, model, with totals and no text", async () => {
	const agent = new Agent({
		model: "tiny",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		keepAnswerFirst: true,
	} as ConstructorParameters<typeof Agent>[0]);
	const reply = await agent.chat(`Read notes.txt and tell me the code word. ${PROMPT_MARK}`);
	await agent.cleanup();
	expect(reply).toContain(FILE_MARK);

	const files = readdirSync(traces);
	expect(files).toHaveLength(1);
	const raw = readFileSync(join(traces, files[0]), "utf8");
	const spans = parseSpans(raw);
	const root = spans.find((s) => s.kind === "run");
	expect(root?.attributes[ATTR.outcome]).toBe("ok");
	expect(root?.attributes[ATTR.model]).toBe("tiny");

	const calls = spans
		.filter((s) => s.kind !== "run")
		.sort((a, b) => a.startTimeUnixNano - b.startTimeUnixNano);
	// One model span per request the model answered; the tool sits between the first two.
	expect(completions).toBeGreaterThanOrEqual(2);
	expect(calls.map((s) => s.name)).toEqual([
		"model ollama/tiny",
		"tool read_file",
		...Array(completions - 1).fill("model ollama/tiny"),
	]);
	expect(runTotals(spans)).toMatchObject({
		modelCalls: completions,
		toolCalls: 1,
		toolFailures: 0,
		tokensIn: 11 * completions,
		tokensOut: 4 * completions,
		costUsd: 0,
	});

	const out: string[] = [];
	expect(traceCommand(["show", files[0].slice(0, 12)], (l) => out.push(l), traces)).toBe(0);
	const shown = out.join("\n");
	expect(shown).toContain("  tool read_file  ok");
	expect(shown).toContain(
		`totals: ${completions} model calls, 1 tool calls (0 failed), tokens in ${11 * completions} out ${4 * completions}`,
	);

	// Prompt text, file contents and the model's words never reach the record.
	for (const text of [raw, shown]) {
		for (const mark of [PROMPT_MARK, FILE_MARK, ANSWER_MARK, "notes.txt"])
			expect(text).not.toContain(mark);
	}
}, 60_000);
