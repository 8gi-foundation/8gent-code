/**
 * #4779: /stack reports what the next turn sends, and its total is the real
 * request, not a re-estimate. Each path is driven through chat() against a fake
 * OpenAI-compatible endpoint, and the report taken before the turn must equal
 * the bytes that went over the wire: system message, declared tools, and every
 * other message except the user's own text.
 *
 * $HOME is faked so the operator's memories and ~/.claude files stay out.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;
let formatStackReport: typeof import("./agent").formatStackReport;

type Msg = { role: string; content: unknown };
type Body = { messages: Msg[]; tools?: unknown[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "stack4779-home-"));
	repo = mkdtempSync(join(tmpdir(), "stack4779-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent, formatStackReport } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			bodies.push((await req.json()) as Body);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

for (const [label, textTools] of [
	["text-tool", "1"],
	["native", "0"],
] as const) {
	describe(`/stack, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		});

		test("the reported total is the request chat() sends, rows largest first", async () => {
			const agent = new Agent({
				model: "m",
				runtime: "ollama",
				workingDirectory: repo,
				baseUrl: `http://127.0.0.1:${server.port}`,
			} as ConstructorParameters<typeof Agent>[0]);
			const report = await agent.stackReport();
			expect(report.path).toBe(label);

			const ask = "read package.json in this repo and list the scripts it defines";
			const start = bodies.length;
			await agent.chat(ask);
			const body = bodies[start];
			if (!body) throw new Error("no model request");

			// The clarify note depends on the words typed, which /stack cannot know;
			// the footer says so. Everything else in the request must be reported.
			const perMessage = body.messages.filter((m) =>
				text(m.content).includes("[PROACTIVE QUESTIONING]"),
			);
			expect(perMessage.length).toBeLessThanOrEqual(1);
			const sent =
				body.messages
					.filter((m) => !perMessage.includes(m))
					.reduce((n, m) => n + bytes(text(m.content)), 0) -
				bytes(ask) +
				(body.tools ?? []).reduce((n: number, t) => n + bytes(JSON.stringify(t)), 0);
			expect(report.totalBytes).toBe(sent);
			expect(report.rows.reduce((n, r) => n + r.bytes, 0)).toBe(report.totalBytes);
			expect(report.tools.map((t) => t.name).sort()).toEqual(
				(body.tools ?? []).map((t) => (t as { function: { name: string } }).function.name).sort(),
			);
			for (let i = 1; i < report.rows.length; i++) {
				expect(report.rows[i - 1].bytes).toBeGreaterThanOrEqual(report.rows[i].bytes);
			}
			for (const line of formatStackReport(report).split("\n")) {
				expect(line.length).toBeLessThanOrEqual(60);
			}
		}, 60_000);
	});
}

describe("8gent stack builds an inspect-only agent", () => {
	test("no session file, no onStart or SessionStart hook, nothing on cleanup", async () => {
		const { getHookManager } = await import("../hooks");
		const hm = getHookManager();
		const fired: string[] = [];
		const exec = hm.executeHooks.bind(hm);
		const fire = hm.fire.bind(hm);
		hm.executeHooks = (async (type: string, ctx: unknown) => {
			fired.push(type);
			return exec(type as never, ctx as never);
		}) as typeof hm.executeHooks;
		hm.fire = (async (event: string, ctx: unknown) => {
			fired.push(event);
			return fire(event as never, ctx as never);
		}) as typeof hm.fire;
		const sessions = join(home, ".8gent", "sessions");
		const list = () => (existsSync(sessions) ? readdirSync(sessions).sort() : []);
		const before = list();
		try {
			const agent = new Agent({
				model: "m",
				runtime: "ollama",
				workingDirectory: repo,
				inspectOnly: true,
			} as ConstructorParameters<typeof Agent>[0]);
			const report = await agent.stackReport();
			expect(report.totalBytes).toBeGreaterThan(0);
			await agent.cleanup();
		} finally {
			hm.executeHooks = exec;
			hm.fire = fire;
		}
		expect(fired).toEqual([]);
		expect(list()).toEqual(before);
	}, 60_000);
});
