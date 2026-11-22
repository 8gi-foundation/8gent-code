/**
 * #331, fourth finding: run 2026-11-22_064409/sigi-dev-arc1-a on main d712dbab logged the
 * next_step send-back at round 16, then turn_end answer at round 24 with reply nextStep true:
 * the model announced a step a second time, the shared once-per-turn bound (noOneHereSent) was
 * spent, and the announcement passed through as the turn's answer.
 *
 * Now, in a forced-unattended session, when the turn ends on an announcement or a question and
 * that bound is spent, the loop appends a fixed "[harness] Turn ended unattended ..." note to the
 * reply, adds one fixed line to `unverified`, and the turn_end record carries
 * reply.closedHonestly true. No extra model call, no tool call. Attended unchanged; a real answer
 * unchanged; with the bound unspent the send-back path runs instead.
 *
 * Production call shape: Agent.chat() against a fake OpenAI-compatible endpoint, as in
 * unattended-intent-331.test.ts and turn-gate-records-331.test.ts, reading the session file the
 * agent writes. $HOME is faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { TextToolMessage } from "../ai/text-tool-client";
import { honestCloseNote, runTextToolAgent } from "../ai/text-tool-loop";
import type { TurnGateEntry } from "../specifications/session/index";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;

// The pilot's last reply, as the turn_end record described it.
const STEP = "Let me analyze the block layouts to find the placement rule.";
const INTENT = `I mapped both train pairs. ${STEP}`;
const ASK = "Should I keep going by hand?";
const QUESTION = `python3 was refused, so I could not test the rule. ${ASK}`;
const FINISHED =
	"DONE: I am stopping here. answer.json is not written. Not verified: the placement rule.";
const REAL_ANSWER = [
	"The rule is a reflection across the vertical axis; I will not guess beyond the train pairs.",
	"Let me know if you want the grid printed.",
].join("\n");

const STEP_NOTE = `[harness] Turn ended unattended on an announced next step, not an answer. The step was not taken. Not done: "${STEP}". Nothing further ran.`;
const QUESTION_NOTE = `[harness] Turn ended unattended on a question, not an answer. No one answered it. Not done: "${ASK}". Nothing further ran.`;

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
	"CI",
];
const saved: Record<string, string | undefined> = {};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
/** What the fake model says on each call of the turn; the last entry repeats. */
let script: string[] = [INTENT];

beforeAll(async () => {
	for (const k of KEYS) saved[k] = process.env[k];
	home = mkdtempSync(join(tmpdir(), "close331-home-"));
	repo = mkdtempSync(join(tmpdir(), "close331-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	process.env.HOME = home;
	process.env.EIGHT_DATA_DIR = join(home, ".8gent");
	process.env.EIGHT_HOME = home;
	process.env.EIGHT_TOOL_CAPABILITY_GATE = "0";
	process.env["8GENT_TWO_STAGE_COMPACT"] = "0";
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	Reflect.deleteProperty(process.env, "CI");
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			calls++;
			const content = script[Math.min(calls, script.length) - 1];
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
	// The local models' path, the one the pilot ran.
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
	calls = 0;
	script = [INTENT];
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

/** The turn_gate entries the agent wrote to its session file, in order. */
function gates(agent: AgentT): TurnGateEntry[] {
	return readFileSync(agent.getSessionFilePath(), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === "turn_gate");
}
const lastEnd = (agent: AgentT) =>
	gates(agent)
		.filter((e) => e.event === "turn_end")
		.at(-1);

const PROMPT =
	"Work out the rule from the train pairs, test it with bun, then write answer.json and report back.";

describe("#331 honest close: production call shape", () => {
	test("bound spent, the turn ends announcing: the note is appended and recorded", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent).map((e) => `${e.event}:${e.gate}:${e.round}`)).toEqual([
			"send_back:next_step:1",
			"send_back:completion:2",
			"send_back:completion:3",
			"turn_end:answer:4",
		]);
		// No extra model call: four rounds, four requests.
		expect(calls).toBe(4);
		// The announcement stays visible, followed by the note that says it was not done.
		expect(reply).toContain(INTENT);
		expect(reply).toContain(STEP_NOTE);
		expect(reply.indexOf(INTENT)).toBeLessThan(reply.indexOf(STEP_NOTE));
		expect(lastEnd(agent)?.reply).toMatchObject({
			nextStep: true,
			unattended: true,
			closedHonestly: true,
		});
	}, 60_000);

	test("bound spent, the turn ends on a second question: the question note", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [QUESTION];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(gates(agent).map((e) => `${e.event}:${e.gate}:${e.round}`)).toEqual([
			"send_back:question:1",
			"turn_end:answer:2",
		]);
		expect(calls).toBe(2);
		expect(reply).toContain(QUESTION_NOTE);
		expect(lastEnd(agent)?.reply).toMatchObject({ question: true, closedHonestly: true });
	}, 60_000);

	test("the record holds booleans only: no reply text, no note text", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT];
		const agent = build();
		await agent.chat(PROMPT);

		const raw = JSON.stringify(gates(agent));
		expect(raw).not.toContain("block layouts");
		expect(raw).not.toContain("Turn ended unattended");
	}, 60_000);

	test("bound spent, then a real DONE answer: no note", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT, FINISHED];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(reply).toContain("answer.json is not written.");
		expect(reply).not.toContain("[harness] Turn ended unattended");
		expect(lastEnd(agent)?.reply).toMatchObject({ done: true, closedHonestly: false });
	}, 60_000);

	test("a real answer, unattended: no note, not sent back", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [REAL_ANSWER];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(calls).toBe(1);
		expect(reply).toContain("Let me know if you want the grid printed.");
		expect(reply).not.toContain("[harness] Turn ended unattended");
		expect(lastEnd(agent)?.reply).toMatchObject({ closedHonestly: false });
	}, 60_000);

	test("bound unspent: the announcement is sent back, the note is not used", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT, FINISHED];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		// The first announcement went to the send-back path, never to the note.
		expect(gates(agent)[0]).toMatchObject({
			event: "send_back",
			gate: "next_step",
			round: 1,
			noOneHereSent: true,
		});
		expect(reply).not.toContain(STEP);
		expect(reply).not.toContain("[harness] Turn ended unattended");
	}, 60_000);

	test("attended: the announcement ends the turn as before, no note", async () => {
		script = [INTENT];
		const agent = build();
		const reply = await agent.chat(PROMPT);

		expect(calls).toBe(1);
		expect(reply).toContain(INTENT);
		expect(reply).not.toContain("[harness] Turn ended unattended");
		expect(lastEnd(agent)?.reply).toMatchObject({
			nextStep: true,
			unattended: false,
			closedHonestly: false,
		});
	}, 60_000);
});

describe("#331 honest close: the loop result", () => {
	const scripted = (seq: string[]) => {
		let i = 0;
		return async (_m: TextToolMessage[]): Promise<string> => seq[Math.min(i++, seq.length - 1)];
	};

	test("unverified gets one fixed line, without the reply text", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PROMPT }],
			tools: [],
			call: scripted([QUESTION]),
			maxRounds: 6,
		});
		expect(result.rounds).toBe(2);
		expect(result.unverified).toEqual(["turn ended unattended on a question, not an answer"]);
		expect(result.content.endsWith(QUESTION_NOTE)).toBe(true);
	});

	test("the note is fixed text around the quoted step; no long dash", () => {
		expect(honestCloseNote(INTENT)).toBe(STEP_NOTE);
		expect(honestCloseNote(QUESTION)).toBe(QUESTION_NOTE);
		expect(honestCloseNote(`**${STEP}**`)).toBe(STEP_NOTE);
		const long = `Let me ${"check the grid ".repeat(40)}now.`;
		expect(honestCloseNote(long).length).toBeLessThan(400);
		expect(STEP_NOTE + QUESTION_NOTE).not.toMatch(/[–—]/);
	});
});
