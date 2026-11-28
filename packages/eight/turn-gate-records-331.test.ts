/**
 * #331 follow-up: the text-tool loop's harness send-backs were written nowhere, so a pilot run
 * could not show which gate fired or why one did not (run 2026-11-22_024406). Each send-back now
 * leaves one `turn_gate` entry in the session file (gate id, round, the counters that bound it),
 * and the turn's exit leaves one more. Ids, counters and booleans only: no reply text.
 *
 * Production call shape: Agent.chat() against a fake OpenAI-compatible endpoint, as in
 * unattended-intent-331.test.ts, reading the session file the agent writes. $HOME is faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { TextToolMessage } from "../ai/text-tool-client";
import { type TextTool, runTextToolAgent } from "../ai/text-tool-loop";
import type { TurnGateEntry, TurnGateRecord } from "../specifications/session/index";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;

const INTENT =
	"Let me extract the exact filled block positions and compare to the input to find the placement rule.";
const QUESTION =
	"python3 was refused, so I could not test the rule. Should I continue by hand or try bun?";
const FINISHED =
	"DONE: I am stopping here. answer.json is not written. Not verified: the placement rule.";

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
	// Keep the run's EIGHT_HOME from the test preload (#3240) and make this
	// file's folders under it, as the other tests in this package do, so the board path
	// frozen at module load stays under the run's temp home.
	const runHome = process.env.EIGHT_HOME ?? "";
	if (!(runHome.startsWith(tmpdir()) || runHome.startsWith(realpathSync(tmpdir())))) throw new Error("EIGHT_HOME is not a temp dir");
	home = mkdtempSync(join(runHome, "gate331-home-"));
	repo = mkdtempSync(join(runHome, "gate331-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	process.env.HOME = home;
	process.env.EIGHT_DATA_DIR = join(home, ".8gent");
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

const PROMPT =
	"Work out the rule from the train pairs, test it with bun, then write answer.json and report back.";

describe("#331 turn gate records: production call shape", () => {
	test("a question send-back leaves gate 'question' at round 1, then the turn end", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [QUESTION, FINISHED];
		const agent = build();
		await agent.chat(PROMPT);

		const g = gates(agent);
		expect(g.map((e) => [e.event, e.gate, e.round])).toEqual([
			["send_back", "question", 1],
			["turn_end", "answer", 2],
		]);
		expect(g[0].noOneHereSent).toBe(true);
		expect(g[0].checksSent).toBe(0);
		expect(g[0].maxRounds).toBeGreaterThan(1);
		expect(g[1].reply).toMatchObject({ done: true, question: false, unattended: true });
	}, 60_000);

	test("a next-step send-back leaves gate 'next_step' at round 1, then the turn end", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT, FINISHED];
		const agent = build();
		await agent.chat(PROMPT);

		const g = gates(agent);
		expect(g.map((e) => [e.event, e.gate, e.round])).toEqual([
			["send_back", "next_step", 1],
			["turn_end", "answer", 2],
		]);
		expect(g[0].noOneHereSent).toBe(true);
		expect(g[1].reply).toMatchObject({ done: true, nextStep: false, stalled: false });
	}, 60_000);

	test("spent budgets: the turn end says it was a stall past its checks, still announcing", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT];
		const agent = build();
		await agent.chat(PROMPT);

		const g = gates(agent);
		expect(g.map((e) => [e.event, e.gate, e.round])).toEqual([
			["send_back", "next_step", 1],
			["send_back", "completion", 2],
			["send_back", "completion", 3],
			["turn_end", "answer", 4],
		]);
		expect(g[2].checksSent).toBe(2);
		expect(g[2].checksWithoutProgress).toBe(2);
		expect(g[3].reply).toMatchObject({
			done: false,
			nextStep: true,
			stalled: true,
			unattended: true,
		});
	}, 60_000);

	test("attended: no send-back, and the turn end records the announcement it let through", async () => {
		script = [INTENT];
		const agent = build();
		await agent.chat(PROMPT);

		const g = gates(agent);
		expect(g.map((e) => [e.event, e.gate, e.round])).toEqual([["turn_end", "answer", 1]]);
		expect(g[0].reply).toMatchObject({ nextStep: true, unattended: false, done: false });
	}, 60_000);

	test("the records carry no reply text and no sent-back text", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		script = [INTENT, FINISHED];
		const agent = build();
		await agent.chat(PROMPT);

		const g = gates(agent);
		expect(g).toHaveLength(2);
		const raw = JSON.stringify(g);
		expect(raw).not.toContain("placement rule");
		expect(raw).not.toContain("No one is here");
	}, 60_000);
});

describe("#331 turn gate records: the sink never changes the turn", () => {
	const scripted = (seq: string[]) => {
		let i = 0;
		return async (_m: TextToolMessage[]): Promise<string> => seq[Math.min(i++, seq.length - 1)];
	};
	const READ: TextTool = {
		spec: {
			name: "read_file",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		run: async () => "contents",
	};
	const TOOL_REPLY = [
		"```tool_call",
		'{"name": "read_file", "arguments": {"path": "/tmp/x.txt"}}',
		"```",
	].join("\n");

	test("a sink that throws leaves the same answer and rounds as no sink", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		const base = {
			messages: [{ role: "user" as const, content: PROMPT }],
			tools: [],
			maxRounds: 6,
		};
		const without = await runTextToolAgent({ ...base, call: scripted([QUESTION, FINISHED]) });
		const withThrow = await runTextToolAgent({
			...base,
			call: scripted([QUESTION, FINISHED]),
			onGate: () => {
				throw new Error("sink down");
			},
		});
		expect(withThrow.content).toBe(without.content);
		expect(withThrow.rounds).toBe(without.rounds);
		expect(without.rounds).toBe(2);
	});

	test("the round cap is a turn end of its own", async () => {
		const seen: string[] = [];
		await runTextToolAgent({
			messages: [{ role: "user", content: PROMPT }],
			tools: [READ],
			call: scripted([TOOL_REPLY]),
			maxRounds: 2,
			onGate: (r) => seen.push(`${r.event}:${r.gate}:${r.round}`),
		});
		expect(seen).toEqual(["turn_end:round_cap:2"]);
	});

	test("a completion check after tool work is gate 'completion' with its counters", async () => {
		const seen: TurnGateRecord[] = [];
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PROMPT }],
			tools: [READ],
			call: scripted([TOOL_REPLY, "The file says contents.", "DONE: The file says contents."]),
			onGate: (r) => seen.push(r),
		});
		expect(result.rounds).toBe(3);
		expect(seen.map((r) => `${r.event}:${r.gate}:${r.round}`)).toEqual([
			"send_back:completion:2",
			"turn_end:answer:3",
		]);
		expect(seen[0]).toMatchObject({ checksSent: 1, checksWithoutProgress: 1, maxRounds: 6 });
	});
});
