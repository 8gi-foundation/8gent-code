/**
 * Headless runs (`8gent run`) send a lean prompt to a local model.
 *
 * The SIGI baseline measured about 9k system-prompt tokens on every model
 * call of a headless `--provider ollama` run, 3 to 41 calls per item. On a
 * local model that prefill is a large share of the wall time. This drives the
 * shipping chat() path against a fake Ollama endpoint, measures what goes over
 * the wire per section, and holds the headless request to at most 60% of the
 * interactive one while keeping every tool, its parameters, and the safety
 * rules.
 *
 * $HOME is faked so the operator's real memories and ~/.claude files stay out.
 * Run with HEADLESS_PROMPT_REPORT=1 to print the per-section breakdown.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLIDES_TO_VIDEO_NOTE } from "./prompts/system-prompt";

let Agent: typeof import("./agent").Agent;

type Msg = { role: string; content: string };
type Decl = { type: string; function: { name: string; description?: string; parameters?: unknown } };
type Body = { messages: Msg[]; tools?: Decl[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];
// The fake model calls one tool on its first reply, then answers.
let script: string[] = [];

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "headless-prompt-home-"));
	repo = mkdtempSync(join(tmpdir(), "headless-prompt-repo-"));
	mkdirSync(join(home, ".8gent"), { recursive: true });
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
			// Only the agent turn carries a system prompt; probes do not.
			if (body.messages?.[0]?.role === "system") bodies.push(body);
			const content = script.shift() ?? "4";
			return Response.json({
				choices: [
					{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
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
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

/** Every request the model receives for one chat() turn. */
async function run(headless: boolean, replies: string[] = []): Promise<Body[]> {
	script = replies.slice();
	const start = bodies.length;
	const agent = new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		maxTurns: 5,
		keepAnswerFirst: headless,
		headless,
	} as ConstructorParameters<typeof Agent>[0]);
	await agent.chat("What is 2+2?");
	const sent = bodies.slice(start);
	if (sent.length === 0) throw new Error("no model request");
	return sent;
}

/** What the model reads before the conversation: the system prompt plus the declared tools. */
const prefixChars = (b: Body) =>
	b.messages[0].content.length + (b.tools ? JSON.stringify(b.tools).length : 0);
const approxTokens = (chars: number) => Math.round(chars / 4);

function sections(b: Body): Array<[string, number]> {
	const sys = b.messages[0].content;
	const rows: Array<[string, number]> = [];
	const listAt = sys.indexOf("Available tools (signature - description):");
	const personaAt = sys.indexOf("You are 8gent");
	rows.push(["tool-call protocol + rules", listAt]);
	rows.push(["tool list (text)", personaAt - listAt]);
	const catalogAt = sys.indexOf("## TOOLS YOU HAVE");
	if (catalogAt >= 0) {
		rows.push(["persona", catalogAt - personaAt]);
		rows.push(["tool catalog", sys.length - catalogAt]);
	} else rows.push(["persona + notes", sys.length - personaAt]);
	rows.push(["declared tools (JSON)", b.tools ? JSON.stringify(b.tools).length : 0]);
	return rows;
}

describe("headless prompt diet", () => {
	test("the headless prefix is at most 60% of the interactive one", async () => {
		const [interactive] = await run(false);
		const [headless] = await run(true);
		if (process.env.HEADLESS_PROMPT_REPORT === "1") {
			for (const [label, b] of [
				["interactive", interactive],
				["headless", headless],
			] as const) {
				console.log(`\n${label}: ${prefixChars(b)} chars, ~${approxTokens(prefixChars(b))} tokens`);
				for (const [name, chars] of sections(b)) {
					console.log(`  ${name.padEnd(28)} ${String(chars).padStart(6)} chars ~${approxTokens(chars)} tok`);
				}
			}
		}
		expect(prefixChars(headless)).toBeLessThanOrEqual(prefixChars(interactive) * 0.6);
	}, 60_000);

	test("headless keeps every tool and its parameters, declared and listed", async () => {
		const [interactive] = await run(false);
		const [headless] = await run(true);
		const params = (b: Body) =>
			Object.fromEntries((b.tools ?? []).map((t) => [t.function.name, t.function.parameters]));
		expect(Object.keys(params(headless)).length).toBeGreaterThan(10);
		expect(params(headless)).toEqual(params(interactive));
		for (const name of Object.keys(params(headless))) {
			expect(headless.messages[0].content).toContain(`\n${name}(`);
		}
	}, 60_000);

	test("headless keeps the safety and honesty rules", async () => {
		const [headless] = await run(true);
		const sys = headless.messages[0].content;
		expect(sys).toContain("Never claim you performed an action");
		expect(sys).toContain("NEVER guess, invent, or recall a tool's output");
		expect(sys).toContain("you MUST use the write_file tool");
		expect(sys).toContain("Do not claim you have no internet access");
	}, 60_000);

	test("headless carries the shared slides-to-video note (#3862)", async () => {
		const [headless] = await run(true);
		expect(headless.messages[0].content).toContain(SLIDES_TO_VIDEO_NOTE);
	}, 60_000);

	test("headless does not advertise tools the run does not offer", async () => {
		const [headless] = await run(true);
		const sys = headless.messages[0].content;
		const offered = new Set((headless.tools ?? []).map((t) => t.function.name));
		expect(offered.has("desktop_screenshot")).toBe(false);
		expect(sys).not.toContain("desktop_screenshot");
		expect(sys).not.toContain("## TOOLS YOU HAVE");
	}, 60_000);

	test("the interactive prompt is unchanged by the headless option", async () => {
		const [a] = await run(false);
		const sys = a.messages[0].content;
		expect(sys).toContain("## TOOLS YOU HAVE");
		expect(a.tools?.every((t) => typeof t.function.description === "string")).toBe(true);
	}, 60_000);

	test("headless calls in one turn share a byte-identical prefix", async () => {
		const calls = await run(true, [
			'```tool_call\n{"name": "list_files", "arguments": {"path": "."}}\n```',
			"4",
		]);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const [first, second] = calls;
		expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
		expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(
			JSON.stringify(first.messages),
		);
	}, 60_000);
});
