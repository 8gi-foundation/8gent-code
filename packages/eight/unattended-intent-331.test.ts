/**
 * #331 finding 1: with nobody present, a turn may not end on a statement of what the model is
 * about to do. Pilot run 2026-11-22_011411/sigi-dev-arc1-a ended its turn on "Let me extract the
 * exact filled block positions and compare to the input to find the placement rule." with the
 * task unfinished and no answer written.
 *
 * 1. The turn gate. Unattended, a final reply that only announces a next step is sent back once
 *    with a plain line: do that step now, or finish with what you have and state what was not
 *    done. It shares #326's once-per-turn bound with the question send-back, so one turn is never
 *    sent back by both. An attended session is unchanged.
 * 2. The detector is narrow. A real final answer that says "let me know" or "I will" mid-text,
 *    or a DONE-marked reply, is not an announcement.
 *
 * Production call shape: Agent.chat() against a fake OpenAI-compatible endpoint, as in
 * unattended-question-326.test.ts. $HOME is faked. No permission is touched here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import {
	COMPLETION_CHECK_MESSAGE,
	NEXT_STEP_NOT_TAKEN_MESSAGE,
	NO_ONE_HERE_MESSAGE,
	isNextStepOnly,
} from "../ai/text-tool-loop";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;

type Body = { messages: Array<{ role: string; content: unknown }> };

// The pilot's last line, verbatim.
const INTENT =
	"Let me extract the exact filled block positions and compare to the input to find the placement rule.";
const QUESTION =
	"python3 was refused, so I could not test the rule. Should I continue by hand or try bun?";
// A stop, not a success claim: no tool ran in this fake turn, and the honesty guard would say so.
const FINISHED =
	"DONE: I am stopping here. answer.json is not written. Not verified: the placement rule.";
// A real final answer that says "let me know" and "I will" and is not an announcement.
const REAL_ANSWER = [
	"The rule is a reflection across the vertical axis; I will not guess beyond the train pairs.",
	"Let me know if you want the grid printed.",
].join("\n");

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
let bodies: Body[] = [];
/** What the fake model says on each call of the turn; the last entry repeats. */
let script: string[] = [INTENT];

beforeAll(async () => {
	for (const k of KEYS) saved[k] = process.env[k];
	home = mkdtempSync(join(tmpdir(), "intent331-home-"));
	repo = mkdtempSync(join(tmpdir(), "intent331-repo-"));
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
	bodies = [];
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

const userLines = (b: Body, needle: string) =>
	b.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes(needle));
/** The next-step send-backs one request to the model carries. */
const intentSentBack = (b: Body) => userLines(b, "only said what you will do next");
/** The #326 question send-backs one request carries. */
const questionSentBack = (b: Body) => userLines(b, "No one is here to answer");

const PROMPT =
	"Work out the rule from the train pairs, test it with bun, then write answer.json and report back.";

describe("#331 unattended: a reply that only announces a next step does not end the turn", () => {
	test("the announcement is sent back exactly once, and the model's finish is the reply", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT, FINISHED];
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(2);
		expect(intentSentBack(bodies[0])).toHaveLength(0);
		expect(intentSentBack(bodies[1])).toHaveLength(1);
		// The model saw its own announcement, then the plain line.
		const tail = bodies[1].messages.slice(-2);
		expect(tail[0].role).toBe("assistant");
		expect(JSON.stringify(tail[0].content)).toContain("find the placement rule");
		expect(tail[1].content).toBe(NEXT_STEP_NOT_TAKEN_MESSAGE);
		expect(reply).toContain("Not verified: the placement rule.");
		expect(reply).not.toContain("find the placement rule");
	}, 60_000);

	test("the model announces again: the line is never sent a second time", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT];
		await build().chat(PROMPT);

		// Every later request carries the one send-back, never two.
		expect(bodies.length).toBeGreaterThanOrEqual(3);
		for (const b of bodies.slice(1)) expect(intentSentBack(b)).toHaveLength(1);
		// The reply after it must be a tool call or DONE: a second announcement gets the
		// existing completion check, inside that check's own caps, not this line again.
		const third = bodies[2].messages;
		expect(third[third.length - 1].content).toBe(COMPLETION_CHECK_MESSAGE);
	}, 60_000);

	test("shared bound: a question sent back first means a later announcement is not", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [QUESTION, INTENT];
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(2);
		expect(questionSentBack(bodies[1])).toHaveLength(1);
		expect(intentSentBack(bodies[1])).toHaveLength(0);
		expect(reply).toContain("find the placement rule");
	}, 60_000);

	test("shared bound: an announcement sent back first means a later question is not", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT, QUESTION];
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(2);
		expect(intentSentBack(bodies[1])).toHaveLength(1);
		expect(questionSentBack(bodies[1])).toHaveLength(0);
		expect(reply).toContain("try bun?");
	}, 60_000);

	test("a real final answer with 'let me know' and 'I will' mid-text is the reply, not sent back", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [REAL_ANSWER];
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(1);
		expect(reply).toContain("Let me know if you want the grid printed.");
	}, 60_000);

	test("the plain line says do the step now or finish and state what was not done, no long dash", () => {
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE).toMatch(/^No one is here/);
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE).toContain("Do that step now");
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE).toMatch(/finish with what you have/i);
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE).toMatch(/what was not done/i);
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE).not.toMatch(/[–—]/);
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE).not.toBe(NO_ONE_HERE_MESSAGE);
	});
});

describe("#331 8SO hold: a refused step is not ordered taken", () => {
	const REFUSED_THEN_ANNOUNCE =
		"I could not run python3: it needs a person's yes. Let me try writing the file with bun instead.";
	const NO_LINE =
		"If that step was refused or needs a person's yes, do not take it and do not get its effect another way; say it was not done.";

	test("the plain line carries the no line, before the order to do the step", () => {
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE).toContain(NO_LINE);
		expect(NEXT_STEP_NOT_TAKEN_MESSAGE.indexOf(NO_LINE)).toBeLessThan(
			NEXT_STEP_NOT_TAKEN_MESSAGE.indexOf("Do that step now"),
		);
	});

	test("refused, then announced another way: sent back once with the no line", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [REFUSED_THEN_ANNOUNCE, FINISHED];
		const reply = await build().chat(PROMPT);

		expect(isNextStepOnly(REFUSED_THEN_ANNOUNCE)).toBe(true);
		expect(bodies).toHaveLength(2);
		const tail = bodies[1].messages.slice(-2);
		expect(JSON.stringify(tail[0].content)).toContain("writing the file with bun instead");
		expect(tail[1].content).toBe(NEXT_STEP_NOT_TAKEN_MESSAGE);
		expect(String(tail[1].content)).toContain(NO_LINE);
		expect(reply).toContain("Not verified: the placement rule.");
	}, 60_000);
});

describe("#331 attended: unchanged", () => {
	test("an announcement ends the turn as before; nothing is sent back", async () => {
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(1);
		expect(intentSentBack(bodies[0])).toHaveLength(0);
		expect(reply).toContain("find the placement rule");
	}, 60_000);
});

describe("#331 the detector is narrow", () => {
	test.each([
		INTENT,
		"I will now write answer.json.",
		"I'll now run the train pairs again.",
		"Next, I'll compare the grids.",
		"Next I will compare the grids.",
		"Now I need to check the placement of the filled blocks.",
		"Now let me run arc5.js.",
		"Okay, let me look at the output again.",
		"The first two pairs match. Let me check the third pair.",
		"**Let me** read the input grid.",
	])("announces a next step: %p", (text) => {
		expect(isNextStepOnly(text)).toBe(true);
	});

	test.each([
		REAL_ANSWER,
		"Let me know if you want any changes.",
		"Done. Let me know if anything else is needed.",
		"answer.json is written. I will keep the scripts in the work folder.",
		"The rule: each filled block moves down one row. I will note that pair 3 was not verified.",
		"I wrote answer.json with the reflected grid. Next time the scripts can be removed.",
		"DONE: answer.json written. Let me check nothing else is needed.",
		"Should I continue by hand or try bun?",
		"",
		"Let me summarize what I found:\n- pair 1 reflects\n- pair 2 reflects\n- answer.json written",
	])("a real answer, not an announcement: %p", (text) => {
		expect(isNextStepOnly(text)).toBe(false);
	});
});
