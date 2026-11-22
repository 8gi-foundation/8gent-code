/**
 * #331, third finding: run 2026-11-22_045649/sigi-dev-arc1-a on main 30c70a04 logged
 * `send_back silent_calls` at round 12, then `turn_end answer_only` at round 13, and the turn
 * ended on "... Let me continue." In answer-only mode the question (#327) and next-step (#332)
 * gates never ran: whatever the model said was the answer.
 *
 * Now, in a forced-unattended session, an answer-only reply that is a question or only announces
 * a next step gets one send-back (gate "answer_only_final", sharing #326's once-per-turn bound)
 * asking for a DONE summary of what was and was not done, with the no-permission line. Tools stay
 * off: answer-only stays answer-only, and the reply after the send-back ends the turn. With the
 * bound already used the turn ends as before. Attended unchanged.
 *
 * Production call shape: Agent.chat() against a fake OpenAI-compatible endpoint whose tool
 * calls carry no prose, so the real silent-calls check trips (EIGHT_SILENT_CALLS=2), as in
 * turn-gate-records-331.test.ts, reading the session file the agent writes. $HOME is faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { ANSWER_ONLY_UNATTENDED_MESSAGE } from "../ai/text-tool-loop";
import type { TurnGateEntry } from "../specifications/session/index";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;

type Body = { messages: Array<{ role: string; content: unknown }> };

// The pilot's last sentence, and a tool call with no prose around it.
const INTENT = "I have the rule and now need to run it to confirm against the train pairs. Let me continue.";
const QUESTION = "I found the rule for two pairs. Should I keep going?";
const TOOL = ["```tool_call", '{"name": "list_files", "arguments": {"path": "."}}', "```"].join("\n");
const FINISHED =
	"DONE: The rule fits two pairs. Not done: answer.json is not written. Not verified: pair 3.";
const REAL_ANSWER =
	"The rule is a reflection across the vertical axis; it fits both train pairs. Let me know if you want the grid.";

const KEYS = [
	"HOME",
	"EIGHT_DATA_DIR",
	"EIGHT_HOME",
	"EIGHT_TOOL_CAPABILITY_GATE",
	"8GENT_TWO_STAGE_COMPACT",
	"EIGHT_TEXT_TOOLS",
	"OLLAMA_HOST",
	"EIGHT_UNATTENDED",
	"EIGHT_HEADLESS",
	"EIGHT_SILENT_CALLS",
	"CI",
];
const saved: Record<string, string | undefined> = {};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
/** What the fake model says on each call of the turn; the last entry repeats. */
let script: string[] = [TOOL, TOOL, INTENT];

beforeAll(async () => {
	for (const k of KEYS) saved[k] = process.env[k];
	home = mkdtempSync(join(tmpdir(), "answeronly331-home-"));
	repo = mkdtempSync(join(tmpdir(), "answeronly331-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	process.env.HOME = home;
	process.env.EIGHT_DATA_DIR = join(home, ".8gent");
	process.env.EIGHT_HOME = home;
	process.env.EIGHT_TOOL_CAPABILITY_GATE = "0";
	process.env["8GENT_TWO_STAGE_COMPACT"] = "0";
	// Two silent tool calls trip the check, so the third model call is answer-only.
	process.env.EIGHT_SILENT_CALLS = "2";
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	Reflect.deleteProperty(process.env, "CI");
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			bodies.push((await req.json()) as Body);
			const content = script[Math.min(bodies.length, script.length) - 1];
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.EIGHT_TEXT_TOOLS = "1";
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmRetry(home);
	rmRetry(repo);
});

beforeEach(() => {
	bodies = [];
	script = [TOOL, TOOL, INTENT];
	Reflect.deleteProperty(process.env, "EIGHT_UNATTENDED");
});

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** The turn_gate entries the agent wrote to its session file, as event:gate:round. */
function gates(agent: AgentT): string[] {
	return readFileSync(agent.getSessionFilePath(), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as TurnGateEntry)
		.filter((e) => e.type === "turn_gate")
		.map((e) => `${e.event}:${e.gate}:${e.round}`);
}

const sentBack = (b: Body) =>
	b.messages.filter((m) => m.role === "user" && m.content === ANSWER_ONLY_UNATTENDED_MESSAGE);

const PROMPT =
	"Work out the rule from the train pairs, test it with bun, then write answer.json and report back.";

describe("#331 unattended answer-only: the reply must still be a final answer", () => {
	test("an announcement after silent calls is sent back once; the DONE summary is the reply", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [TOOL, TOOL, INTENT, FINISHED];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent)).toEqual([
			"send_back:silent_calls:2",
			"send_back:answer_only_final:3",
			"turn_end:answer_only:4",
		]);
		expect(bodies).toHaveLength(4);
		expect(sentBack(bodies[3])).toHaveLength(1);
		const tail = bodies[3].messages.slice(-2);
		expect(JSON.stringify(tail[0].content)).toContain("Let me continue.");
		expect(tail[1].content).toBe(ANSWER_ONLY_UNATTENDED_MESSAGE);
		expect(reply).toContain("Not done: answer.json is not written.");
		expect(reply).not.toContain("Let me continue.");
	}, 60_000);

	test("a question after silent calls is sent back the same way", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [TOOL, TOOL, QUESTION, FINISHED];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent)).toEqual([
			"send_back:silent_calls:2",
			"send_back:answer_only_final:3",
			"turn_end:answer_only:4",
		]);
		expect(reply).toContain("Not verified: pair 3.");
	}, 60_000);

	test("answer-only stays answer-only: a tool call after the send-back is not run, the turn ends", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [TOOL, TOOL, INTENT, TOOL, FINISHED];
		const agent = build();
		await agent.chat(PROMPT);

		expect(gates(agent)).toEqual([
			"send_back:silent_calls:2",
			"send_back:answer_only_final:3",
			"turn_end:answer_only:4",
		]);
		expect(bodies).toHaveLength(4);
	}, 60_000);

	test("once per turn: a second announcement ends the turn, never sent back twice", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [TOOL, TOOL, INTENT];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent)).toEqual([
			"send_back:silent_calls:2",
			"send_back:answer_only_final:3",
			"turn_end:answer_only:4",
		]);
		expect(reply).toContain("Let me continue.");
	}, 60_000);

	test("shared bound: a question sent back earlier means the answer-only announcement ends the turn", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = ["Should I start with pair 1?", TOOL, TOOL, INTENT];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent)).toEqual([
			"send_back:question:1",
			"send_back:silent_calls:3",
			"turn_end:answer_only:4",
		]);
		expect(reply).toContain("Let me continue.");
	}, 60_000);

	test("a real final answer in answer-only mode ends the turn, not sent back", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [TOOL, TOOL, REAL_ANSWER];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent)).toEqual(["send_back:silent_calls:2", "turn_end:answer_only:3"]);
		expect(reply).toContain("Let me know if you want the grid.");
	}, 60_000);

	test("the plain line: final answer only, no tools, the no line, DONE summary; no long dash", () => {
		expect(ANSWER_ONLY_UNATTENDED_MESSAGE).toMatch(/^No one is here/);
		expect(ANSWER_ONLY_UNATTENDED_MESSAGE).toContain("Tools are not available");
		expect(ANSWER_ONLY_UNATTENDED_MESSAGE).toContain(
			"If a step was refused or needs a person's yes, do not take it and do not get its effect another way; say it was not done.",
		);
		expect(ANSWER_ONLY_UNATTENDED_MESSAGE).toMatch(/what was done and what was not done/);
		expect(ANSWER_ONLY_UNATTENDED_MESSAGE).toContain('Start it with "DONE:"');
		expect(ANSWER_ONLY_UNATTENDED_MESSAGE).not.toMatch(/tool_call/);
		expect(ANSWER_ONLY_UNATTENDED_MESSAGE).not.toMatch(/[–—]/);
	});
});

describe("#331 attended answer-only: unchanged", () => {
	test("an announcement after silent calls ends the turn as before", async () => {
		script = [TOOL, TOOL, INTENT];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent)).toEqual(["send_back:silent_calls:2", "turn_end:answer_only:3"]);
		expect(bodies).toHaveLength(3);
		expect(reply).toContain("Let me continue.");
	}, 60_000);
});
