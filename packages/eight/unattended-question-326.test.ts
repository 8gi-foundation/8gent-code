/**
 * #326 fault 1: with nobody present, a turn may not end on a question to the person.
 *
 * 1. The turn gate. On the text-tool path (the local models' path, the one the pilot ran) a
 *    reply that is a question ends the turn. Unattended, that question is sent back to the
 *    model exactly once with a plain line: no one is here, a question asking permission or
 *    confirmation is answered no, do not take that step or get its effect another way, finish
 *    only what needs no permission and state what was not done and not verified. A second question ends the turn; it is never sent back
 *    twice. An attended session is unchanged: the question ends the turn and reaches the person.
 * 2. The refusal words. A command refused for want of a person tells the model to carry on
 *    with the steps that do not need it and not to get its effect another way, and still says
 *    the command was not run and not to retry.
 *
 * Production call shape: Agent.chat() against a fake OpenAI-compatible endpoint (as in
 * done-gate-agent.test.ts) and ToolExecutor.execute for run_command (as in
 * unattended-refusal-record-310.test.ts). $HOME is faked. No permission is loosened here:
 * the refused command stays refused.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { NO_ONE_HERE_MESSAGE } from "../ai/text-tool-loop";
import { SYSTEM_ONE_FLAG } from "../permissions/system-one-gate";
import { _resetTuiApprovalChannel } from "../permissions/tui-approval-channel";
import type { Agent as AgentT } from "./agent";
import { ToolExecutor } from "./tools";

let Agent: typeof import("./agent").Agent;

type Body = { messages: Array<{ role: string; content: unknown }> };

const QUESTION =
	"python3 was refused, so I could not test the rule. Should I continue by hand or try bun?";
// A stop, not a success claim: no tool ran in this fake turn, and the honesty guard would say so.
const FINISHED =
	"DONE: I am stopping here. answer.json is not written. Not verified: python3 never ran.";

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
	SYSTEM_ONE_FLAG,
];
const saved: Record<string, string | undefined> = {};
let ttyWas: PropertyDescriptor | undefined;
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
/** What the fake model says on each call of the turn; the last entry repeats. */
let script: string[] = [QUESTION];

beforeAll(async () => {
	for (const k of KEYS) saved[k] = process.env[k];
	ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	home = mkdtempSync(join(tmpdir(), "unattended326-home-"));
	repo = mkdtempSync(join(tmpdir(), "unattended326-repo-"));
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
	_resetTuiApprovalChannel();
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	rmRetry(home);
	rmRetry(repo);
});

beforeEach(() => {
	bodies = [];
	script = [QUESTION];
	Reflect.deleteProperty(process.env, "EIGHT_UNATTENDED");
});

afterEach(() => {
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

/** The send-backs one request to the model carries. */
const sentBack = (b: Body) =>
	b.messages.filter(
		(m) => m.role === "user" && JSON.stringify(m.content).includes("No one is here"),
	);

const PROMPT =
	"Work out the rule from the train pairs, test it with python3, then write answer.json and report back.";

describe("#326 unattended: a question to the absent person does not end the turn", () => {
	test("the question is sent back exactly once, and the model's finish is the reply", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [QUESTION, FINISHED];
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(2);
		expect(sentBack(bodies[0])).toHaveLength(0);
		expect(sentBack(bodies[1])).toHaveLength(1);
		// The model saw its own question, then the plain line.
		const tail = bodies[1].messages.slice(-2);
		expect(tail[0].role).toBe("assistant");
		expect(JSON.stringify(tail[0].content)).toContain("try bun?");
		expect(tail[1].content).toBe(NO_ONE_HERE_MESSAGE);
		expect(reply).toContain("Not verified: python3 never ran.");
		expect(reply).not.toContain("try bun?");
	}, 60_000);

	test("the model asks again: the turn ends, the question is not sent back a second time", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [QUESTION];
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(2);
		expect(sentBack(bodies[1])).toHaveLength(1);
		expect(reply).toContain("try bun?");
	}, 60_000);

	test("the plain line says what the issue asks for, with no long dash", () => {
		expect(NO_ONE_HERE_MESSAGE).toMatch(/^No one is here/);
		expect(NO_ONE_HERE_MESSAGE).toMatch(/finish/i);
		expect(NO_ONE_HERE_MESSAGE).toMatch(/not verified/i);
		expect(NO_ONE_HERE_MESSAGE).not.toMatch(/[–—]/);
	});

	test("unattended means no: a permission question is answered no, and its effect is not got another way", () => {
		expect(NO_ONE_HERE_MESSAGE).toContain(
			"A question asking permission or confirmation is answered no.",
		);
		expect(NO_ONE_HERE_MESSAGE).toContain(
			"Do not take that step, and do not get its effect another way.",
		);
		expect(NO_ONE_HERE_MESSAGE).toContain("Say plainly it was not done.");
		expect(NO_ONE_HERE_MESSAGE).toContain("Finish only what needs no permission.");
		// The self-decide line 8SO held at 1fd0722 is gone.
		expect(NO_ONE_HERE_MESSAGE).not.toMatch(/deciding for yourself/i);
		expect(NO_ONE_HERE_MESSAGE).not.toMatch(/whatever you were going to ask/i);
	});
});

describe("#326 attended: unchanged", () => {
	test("a question ends the turn and reaches the person; nothing is sent back", async () => {
		const reply = await build().chat(PROMPT);

		expect(bodies).toHaveLength(1);
		expect(sentBack(bodies[0])).toHaveLength(0);
		expect(reply).toContain("try bun?");
	}, 60_000);
});

describe("#326 the refusal for want of a person says to carry on without it, not around it", () => {
	beforeEach(() => {
		// The pilot's pane: a terminal, not headless, nobody present.
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		_resetTuiApprovalChannel();
		process.env.EIGHT_UNATTENDED = "1";
		process.env[SYSTEM_ONE_FLAG] = "0";
	});

	test("run_command: still refused, not run, no retry; and told not to get its effect another way", async () => {
		// mkfifo is not on the allow list, so the generic approval asks a person.
		const made = join(repo, "made-326");
		const out = String(
			await new ToolExecutor(repo, "carry-on-326").execute("run_command", {
				command: `mkfifo ${made}`,
			}),
		);

		expect(existsSync(made)).toBe(false);
		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain("there is no one to ask in this session");
		expect(out).toContain("The command was not run. Do not retry this call.");
		expect(out).toContain(
			"Carry on with the steps that do not need this command, and do not get its effect another way.",
		);
		expect(out).not.toContain("Carry on with the tools you have");
		expect(out).toMatch(/not done/i);
		expect(out).toMatch(/not verified/i);
		expect(out).toMatch(/Do not ask the person/);
		// #310 still holds: nobody declined, and no way around the gate is named.
		expect(out).not.toMatch(/declined/i);
		expect(out).not.toMatch(/\bapproved\b/i);
		expect(out).not.toContain(`${SYSTEM_ONE_FLAG}=0`);
	});

	test("desktop control: the same closing line", async () => {
		const out = String(
			await new ToolExecutor(repo, "carry-on-326").execute("desktop_quit_app", { name: "Safari" }),
		);

		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain("Nothing was done. Do not retry this call.");
		expect(out).toContain(
			"Carry on with the steps that do not need this command, and do not get its effect another way.",
		);
		expect(out).not.toContain("Carry on with the tools you have");
	});
});
