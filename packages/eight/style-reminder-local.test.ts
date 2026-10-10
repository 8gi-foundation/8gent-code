/**
 * #3487: on the local text-tool path the user's communication style is
 * restated as the LAST message of every model request, so a long tool loop
 * cannot bury it. It is a harness note (user role), never a second system
 * message, and never stored in the history, so the cached prefix is unchanged
 * (#3222). With no style set there is no reminder.
 *
 * Drives the shipping chat() path against a fake OpenAI-compatible endpoint and
 * asserts on the request bodies, like harness-notes-reach-model.test.ts. $HOME
 * is faked so the operator's user.json, memories and sessions stay out of it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
let communicationStyleLine: (style: string) => string;
let CONTEXT_NOTE_HEADER: string;

type Msg = { role: string; content: unknown };
type Body = { messages: Msg[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "remind3487-home-"));
	repo = mkdtempSync(join(tmpdir(), "remind3487-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
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
				choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	ENV.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	({ communicationStyleLine } = await import("./prompts/system-prompt"));
	({ CONTEXT_NOTE_HEADER } = await import("./context-note"));
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function writeUser(identity: Record<string, unknown>) {
	writeFileSync(
		join(home, ".8gent", "user.json"),
		JSON.stringify({ identity: { name: "Pilot", language: "en", ...identity }, onboardingComplete: true }),
	);
}

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

const PROMPT =
	"Using typescript, list the three steps to run the onboarding tests with bun test and read a failing assertion.";

async function turn(agent: AgentT): Promise<Body> {
	const start = bodies.length;
	await agent.chat(PROMPT);
	const body = bodies[start];
	if (!body) throw new Error("no model request");
	return body;
}

const text = (m: Msg | undefined) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content));

describe("style reminder on the local text-tool path", () => {
	for (const style of ["action-first", "concise"]) {
		test(`${style}: the reminder is the last message, user role, and nowhere else`, async () => {
			writeUser({ communicationStyle: style });
			const agent = build();
			const body = await turn(agent);
			const last = body.messages[body.messages.length - 1];
			expect(last?.role).toBe("user");
			expect(text(last)).toContain(CONTEXT_NOTE_HEADER);
			expect(text(last)).toContain(communicationStyleLine(style));
			const reminders = body.messages.filter((m) => text(m).includes("Reminder for your reply"));
			expect(reminders.length).toBe(1);
			// One system turn, and the reminder is not in it.
			expect(body.messages.filter((m) => m.role === "system").length).toBe(1);
			// Not stored: the history the next turn builds on has no reminder.
			const history = (agent as unknown as { messageHistory: { content: string }[] }).messageHistory;
			expect(history.some((m) => m.content.includes("Reminder for your reply"))).toBe(false);
		}, 60_000);
	}

	test("no style set: no reminder in the request", async () => {
		writeUser({});
		const body = await turn(build());
		expect(body.messages.some((m) => text(m).includes("Reminder for your reply"))).toBe(false);
		expect(text(body.messages[body.messages.length - 1])).not.toContain("Communication style:");
	}, 60_000);
});
