import { describe, expect, test } from "bun:test";
import type { TextTool, ToolSpec } from "../ai";
import type { TextToolCall, TextToolMessage } from "../ai/text-tool-client";
import { EMPTY_REPLY_STALL_PREFIX } from "../ai/text-tool-loop";
import {
	NEEDS_DEEP,
	type PromptClass,
	QUESTION,
	QUICK_LABEL,
	classifyPrompt,
	compactSpec,
	pickQuickModel,
	quickLaneEnabled,
	quickMessages,
	quickToolPrompt,
	runQuickAnswer,
} from "./quick-answer";

// The conv-quick-answer pilot prompt, verbatim from ~/.8gent/rishi-pilot/scenarios.json.
const PILOT_PROMPT =
	"Quick question, no need to change anything: if I start this server with APP_MODE=staging and no PORT set, which port does it listen on? And which one when APP_MODE isn't set at all? Just tell me in a sentence or two, then end your reply with exactly one line in this form: ANSWER: staging=<port> unset=<port>";

const TABLE: Array<[string, PromptClass]> = [
	// quick: short questions, nothing asked of the agent but an answer
	[PILOT_PROMPT, "quick"],
	["which port does staging use?", "quick"],
	["What does classifyTaskSize return for a typo fix?", "quick"],
	["where is the agent loop defined", "quick"],
	["how do I deploy the daemon?", "quick"],
	["is #3406 merged?", "quick"],
	["what's the default model in this repo?", "quick"],
	["does the TUI use Ink v6?", "quick"],
	["can you tell me which file owns the failover chain?", "quick"],
	["who owns the permissions package?", "quick"],
	["why does agent.ts have two tool paths?", "quick"],
	["Should we keep EIGHT_TEXT_TOOLS as an override?", "quick"],
	["how many providers are wired in the registry?", "quick"],
	["Quick one, don't edit anything: what's the session watchdog timeout?", "quick"],
	["which test covers the text-tool cut-off case?", "quick"],
	["has the pilot ever passed l5-feature-e2e?", "quick"],
	// deep: James-style instructions, including ones phrased as questions
	["fix the failing test in auth.ts", "deep"],
	["can you merge #3406?", "deep"],
	["why is CI red? fix it", "deep"],
	["look into why the daemon crashes and ship a fix", "deep"],
	["what's left on the board? then file issues for each", "deep"],
	["push it", "deep"],
	["ship it?", "deep"],
	["is it merged? if not, merge it", "deep"],
	["could you rename the flag to EIGHT_QUICK?", "deep"],
	["should we refactor agent.ts? go ahead and do it", "deep"],
	["Write the design doc for #3411 before any code", "deep"],
	["how would you build the quick lane? build it with tests", "deep"],
	["make the tests pass", "deep"],
	["run the pilot on conv-quick-answer and post the gif", "deep"],
	["please review PR 3406 and tell me if it is safe", "deep"],
	["don't forget to push the branch", "deep"],
	["Read the issue, design it, then build it in a worktree off origin/main.", "deep"],
	["explain the agent loop end to end", "deep"],
	["the TUI freezes when I paste a long prompt", "deep"],
	[
		"I want to understand how the daemon handles sessions across channels because I keep seeing duplicates in Telegram and I am not sure whether that is the agent pool or the relay or something in the way the TUI reconnects after sleep, which matters for the demo next week with Kevin and the board on Friday morning, what do you think is going on here?",
		"deep",
	],
	// Discussion questions need judgement, not three reads (8PO review, round 2).
	[
		"I want to understand how the daemon handles sessions across channels because I keep seeing duplicates in Telegram and I am not sure whether that is the agent pool or the relay or something in the way the TUI reconnects after sleep, which matters for the demo next week, what do you think is going on here?",
		"deep",
	],
	["what do you think we should do about the onboarding flow?", "deep"],
	["how should we structure the quick then deep answer flow?", "deep"],
	// 8PO round 2: James-style instructions that came out quick in round 1.
	["is the daemon up? if not restart it", "deep"],
	["is the deploy green? if so, let Kevin know", "deep"],
	["is it green? tell Rishi", "deep"],
	["can you ping Rishi about T51?", "deep"],
	["can you handle the merge for 3406?", "deep"],
	["can you take care of #3406?", "deep"],
	["can you get the tests passing?", "deep"],
	["can we get this merged today?", "deep"],
	["could you have the officers review this?", "deep"],
	["can you get Samantha to review it?", "deep"],
	["can you notify the board when it lands?", "deep"],
	["can you message Kevin the link?", "deep"],
	["can you verify the deploy is live?", "deep"],
	// 8SO round 2: suggestion and command shapes.
	["why don't you push it?", "deep"],
	["git push --force?", "deep"],
	// ...and their read-and-tell neighbours stay quick.
	["have you pushed it?", "quick"],
	["let me know which port staging uses?", "quick"],
	["can you check the logs?", "quick"],
	["can you show me the diff?", "quick"],
	["did you push it?", "quick"],
	["Quick one, no need to change anything: is the daemon up?", "quick"],
	// unclear: nothing to answer yet
	["", "unclear"],
	["why?", "unclear"],
	["and that one?", "unclear"],
	["what about this?", "unclear"],
	["hmm", "unclear"],
	["the tests", "unclear"],
];

describe("classifyPrompt (#3411)", () => {
	test("table has 30+ cases covering all three classes", () => {
		expect(TABLE.length).toBeGreaterThanOrEqual(30);
		for (const c of ["quick", "deep", "unclear"] as const) {
			expect(TABLE.some(([, want]) => want === c)).toBe(true);
		}
	});

	for (const [prompt, want] of TABLE) {
		test(`${want}: ${JSON.stringify(prompt.slice(0, 70))}`, () => {
			expect(classifyPrompt(prompt)).toBe(want);
		});
	}

	test("deterministic: same input, same class", () => {
		for (const [prompt] of TABLE) {
			expect(classifyPrompt(prompt)).toBe(classifyPrompt(prompt));
		}
	});

	test("question shape matches sovereignty-index code_question", () => {
		expect(QUESTION.source).toBe(
			String.raw`\?|^\s*(what|which|where|when|who|whose|why|how|is|are|was|were|does|do|did|can|could|should|would|will|has|have)\b`,
		);
	});
});

describe("lane prompt size (round 4)", () => {
	const spec = {
		name: "read_file",
		description:
			"[FILE] Returns the text of a file at the given path, one line per row. Use offset and limit for big files.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "A long description of the path argument." },
			},
			required: ["path"],
		},
	};
	test("compactSpec keeps the first sentence and param types only", () => {
		const c = compactSpec(spec);
		expect(c.description).toBe("Returns the text of a file at the given path, one line per row.");
		expect(c.parameters).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
	});
	test("quickToolPrompt teaches the tool_call fence in a few lines", () => {
		const p = quickToolPrompt([compactSpec(spec)]);
		expect(p).toContain("```tool_call");
		expect(p).toContain("- read_file(path: string) - Returns the text");
		expect(p.length).toBeLessThan(600);
	});
	test("quickMessages is the lane's system prompt and the user's message, nothing else", () => {
		const m = quickMessages("/w", "which port?");
		expect(m.map((x) => x.role)).toEqual(["system", "user"]);
		expect(m[0].content).toContain("Working directory: /w");
		expect(m[0].content.length).toBeLessThan(600);
		expect(m[1].content).toBe("which port?");
	});
});

describe("pickQuickModel", () => {
	test("EIGHT_QUICK_MODEL wins", () => {
		expect(
			pickQuickModel({ envModel: "x:1b", sessionModel: "big:27b", installed: ["qwen3.5:9b"] }),
		).toEqual({
			model: "x:1b",
			source: "env",
		});
	});
	test("else qwen3.5:9b when installed", () => {
		expect(
			pickQuickModel({ sessionModel: "big:27b", installed: ["big:27b", "qwen3.5:9b"] }),
		).toEqual({
			model: "qwen3.5:9b",
			source: "preferred",
		});
	});
	test("a cloud tag of the preferred model is never picked (8SO Q-L1)", () => {
		expect(
			pickQuickModel({ sessionModel: "big:27b", installed: ["qwen3.5:9b-cloud", "qwen3.5:9b-q8"] }),
		).toEqual({ model: "big:27b", source: "session" });
	});
	test("else the session model", () => {
		expect(
			pickQuickModel({ envModel: " ", sessionModel: "big:27b", installed: ["llama3.1:8b"] }),
		).toEqual({
			model: "big:27b",
			source: "session",
		});
	});
});

describe("quickLaneEnabled", () => {
	test("default off, on only for EIGHT_QUICK_ANSWER=1", () => {
		expect(quickLaneEnabled({})).toBe(false);
		expect(quickLaneEnabled({ EIGHT_QUICK_ANSWER: "0" })).toBe(false);
		expect(quickLaneEnabled({ EIGHT_QUICK_ANSWER: "true" })).toBe(false);
		expect(quickLaneEnabled({ EIGHT_QUICK_ANSWER: "1" })).toBe(true);
	});
});

// ── Fast path against a fake model ─────────────────────────────────────

function tool(name: string, log: string[]): TextTool {
	return {
		spec: {
			name,
			description: name,
			parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
		},
		run: async (args) => {
			log.push(`${name}:${String(args.path ?? "")}`);
			return name === "read_file" ? `contents of ${String(args.path)}: PORT=4100` : "ok";
		},
	};
}

const toolCall = (name: string, path: string) =>
	["```tool_call", JSON.stringify({ name, arguments: { path } }), "```"].join("\n");

const USER: TextToolMessage[] = [{ role: "user", content: "which port does staging use?" }];

/** A fake model: replies in order, records what it saw. */
function fakeModel(replies: Array<string | (() => Promise<string>)>) {
	const seen: TextToolMessage[][] = [];
	const declared: string[][] = [];
	let i = 0;
	const makeCall =
		(_signal: AbortSignal, _timeoutMs: number, specs: ToolSpec[]): TextToolCall =>
		async (msgs) => {
			declared.push(specs.map((s) => s.name));
			seen.push(msgs);
			const r = replies[Math.min(i++, replies.length - 1)];
			return typeof r === "function" ? r() : r;
		};
	return { makeCall, seen, declared, calls: () => i };
}

describe("runQuickAnswer (#3411)", () => {
	test("answers from a read-only tool, labelled, inside budget", async () => {
		const ran: string[] = [];
		const m = fakeModel([toolCall("read_file", "server.ts"), "DONE: Staging listens on 4100."]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", ran), tool("write_file", ran)],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.result.content.startsWith(QUICK_LABEL)).toBe(true);
		expect(out.result.content).toContain("4100");
		expect(ran).toEqual(["read_file:server.ts"]);
		// The lane instruction rides at the end; the caller's array is untouched.
		expect(m.seen[0].at(-1)?.content).toContain("[QUICK ANSWER]");
		expect(USER).toHaveLength(1);
	});

	test("write tools are never offered or run", async () => {
		const ran: string[] = [];
		const m = fakeModel([
			toolCall("write_file", "x.ts"),
			"DONE: Could not write, answering: 4100.",
		]);
		await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", ran), tool("write_file", ran), tool("run_command", ran)],
			makeCall: m.makeCall,
		});
		expect(ran.filter((r) => !r.startsWith("read_file"))).toEqual([]);
		// Only the read-only tools are declared to the model.
		expect(m.declared[0]).toEqual(["read_file"]);
	});

	test("a 4th tool call never runs; told the budget is used, the model can still answer", async () => {
		const ran: string[] = [];
		const m = fakeModel([
			[toolCall("read_file", "a.ts"), toolCall("read_file", "b.ts")].join("\n"),
			[toolCall("read_file", "c.ts"), toolCall("read_file", "d.ts")].join("\n"),
			"DONE: 4100.",
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", ran)],
			makeCall: m.makeCall,
		});
		expect(ran).toHaveLength(3);
		expect(out.ok).toBe(true);
		expect(out.tools).toBe(3);
	});

	test("one call per round for 3 reads, then a blocked 4th: the extra round still gets the answer (round 5 repro)", async () => {
		const ran: string[] = [];
		const m = fakeModel([
			toolCall("search_symbols", "server"),
			toolCall("read_file", "src/server.ts"),
			toolCall("read_file", "src/ports.ts"),
			toolCall("read_file", "src/env.ts"),
			"DONE: staging listens on 4100.\nANSWER: staging=4100 unset=3000",
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", ran), tool("search_symbols", ran)],
			makeCall: m.makeCall,
		});
		expect(ran).toHaveLength(3);
		expect(out.ok).toBe(true);
	});

	test("a model that never stops calling tools falls through as 'no answer', with the stall logged", async () => {
		const m = fakeModel([toolCall("read_file", "a.ts")]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.reason).toBe("no answer after 3 tool calls");
		expect(out.claims?.[0]).toContain("without an answer");
		for (const c of out.claims ?? []) expect(c.length).toBeLessThanOrEqual(120);
	});

	test("a model that stalls past the budget falls through", async () => {
		const m = fakeModel([() => new Promise<string>((r) => setTimeout(() => r("DONE: late"), 200))]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [],
			makeCall: m.makeCall,
			budgetMs: 50,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toContain("over 50 ms");
	});

	test("an answer that read nothing falls through: memory is not the source", async () => {
		const m = fakeModel(["DONE: Staging listens on 4100."]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("no source read");
		expect(out.tools).toBe(0);
	});

	test("the outcome reports the tool calls used", async () => {
		const m = fakeModel([toolCall("read_file", "server.ts"), "DONE: 4100."]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(true);
		expect(out.tools).toBe(1);
	});

	test("the instruction tells the model to hand over any action", async () => {
		const m = fakeModel([NEEDS_DEEP]);
		await runQuickAnswer({ messages: USER, tools: [], makeCall: m.makeCall });
		expect(m.seen[0].at(-1)?.content).toContain("asks you to do, change, send or check something");
	});

	test("a read that never finishes cannot hold the lane past its budget", async () => {
		const hang: TextTool = { ...tool("read_file", []), run: () => new Promise<string>(() => {}) };
		const m = fakeModel([toolCall("read_file", "server.ts"), "DONE: 4100."]);
		const t0 = Date.now();
		const out = await runQuickAnswer({
			messages: USER,
			tools: [hang],
			makeCall: m.makeCall,
			budgetMs: 80,
		});
		expect(Date.now() - t0).toBeLessThan(1_000);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toContain("over 80 ms");
	});

	test("the instruction rides on the user's message, so the claim check reads the question", async () => {
		const m = fakeModel([NEEDS_DEEP]);
		await runQuickAnswer({ messages: USER, tools: [], makeCall: m.makeCall });
		const users = m.seen[0].filter((x) => x.role === "user");
		expect(users).toHaveLength(1);
		expect(users[0].content.startsWith("which port does staging use?")).toBe(true);
		expect(users[0].content).toContain("[QUICK ANSWER]");
	});

	test("an answer that says it cannot answer falls through (round 5 repro)", async () => {
		const m = fakeModel([
			toolCall("read_file", "src/server.ts"),
			"DONE: I need to recall the PORTS definition from src/ports.ts. Since I haven't read it yet, I cannot give an accurate answer without it.",
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("model said it could not answer");
	});

	test("a reply that is a malformed tool call is not an answer (round 5 repro)", async () => {
		const m = fakeModel([
			toolCall("read_file", "src/server.ts"),
			'I need to find the port mappings. Let me search for where PORTS is defined.\n\n\n{"name": "search_symbols", "arguments": {"query": "PORTS"}}\n```',
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("tool-call markup in the answer");
	});

	test("'let me check' prose is not an answer", async () => {
		const m = fakeModel([
			toolCall("read_file", "src/server.ts"),
			"DONE: Let me check ports.ts for the stage port.",
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("model said it could not answer");
	});

	for (const [shape, reply] of [
		[
			"name then arguments",
			'Checking. {"name": "read_file", "arguments": {"path": "src/ports.ts"}}',
		],
		[
			"arguments then name",
			'Checking. {"arguments": {"path": "src/ports.ts"}, "name": "read_file"}',
		],
		["<tool_call> tags, bare args", "<tool_call>read_file src/ports.ts</tool_call>"],
		["tool_call fence", '```tool_call\n{"name": "read_file"'],
	] as const) {
		test(`leftover tool-call markup is not an answer: ${shape} (8SO L2)`, async () => {
			const m = fakeModel([toolCall("read_file", "src/server.ts"), `DONE: ${reply}`]);
			const out = await runQuickAnswer({
				messages: USER,
				tools: [tool("read_file", [])],
				makeCall: m.makeCall,
			});
			expect(out.ok).toBe(false);
			if (!out.ok) expect(out.reason).toBe("tool-call markup in the answer");
		});
	}

	test("<tool_call> tags around valid JSON are parsed by the loop as a call, so never shown as an answer", async () => {
		const m = fakeModel([
			toolCall("read_file", "src/server.ts"),
			'DONE: <tool_call>\n{"name": "read_file", "arguments": {"path": "src/ports.ts"}}\n</tool_call>',
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
	});

	test("a tool call cut off in the last round is not shown as the answer", async () => {
		const m = fakeModel([
			toolCall("read_file", "a.ts"),
			'DONE: ```tool_call\n{"name": "read_file"',
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("tool-call markup in the answer");
	});

	// A request that names a command the lane cannot run: the loop's claim check flags it.
	const CMD_USER: TextToolMessage[] = [
		{ role: "user", content: "which port does staging use? run `ls src` first" },
	];

	test("a real flagged claim alone: unverified claims, not ok (8PO round 6)", async () => {
		const m = fakeModel([toolCall("read_file", "src/server.ts"), "DONE: Staging uses 4100."]);
		const out = await runQuickAnswer({
			messages: CMD_USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.reason).toBe("unverified claims");
		expect(out.claims?.some((c) => c.includes("ls src"))).toBe(true);
	});

	test("a real flagged claim together with the empty-reply stall is still unverified claims", async () => {
		const m = fakeModel([toolCall("read_file", "src/server.ts"), ""]);
		const out = await runQuickAnswer({
			messages: CMD_USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.reason).toBe("unverified claims");
		expect(out.claims?.some((c) => c.startsWith(EMPTY_REPLY_STALL_PREFIX))).toBe(true);
		expect(out.claims?.some((c) => c.includes("ls src"))).toBe(true);
	});

	test("the stall alone is named as no answer", async () => {
		const m = fakeModel([toolCall("read_file", "src/server.ts"), ""]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("no answer after 1 tool calls");
	});

	test("a plain answer is not mistaken for a non-answer", async () => {
		const m = fakeModel([
			toolCall("read_file", "src/server.ts"),
			"DONE: Staging maps to the stage port, 4180; with APP_MODE unset it falls back to dev, 3000.\nANSWER: staging=4180 unset=3000",
		]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(true);
	});

	test("NEEDS_DEEP from the model falls through", async () => {
		const m = fakeModel([NEEDS_DEEP]);
		const out = await runQuickAnswer({ messages: USER, tools: [], makeCall: m.makeCall });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toContain("full loop");
	});

	test("an empty answer falls through", async () => {
		const m = fakeModel(["   "]);
		const out = await runQuickAnswer({ messages: USER, tools: [], makeCall: m.makeCall });
		expect(out.ok).toBe(false);
	});

	test("a model error falls through instead of throwing", async () => {
		const makeCall = (): TextToolCall => async () => {
			throw new Error("ollama chat completions 404");
		};
		const out = await runQuickAnswer({ messages: USER, tools: [], makeCall });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toContain("404");
	});

	test("the turn's ESC aborts the lane", async () => {
		const ac = new AbortController();
		ac.abort();
		const m = fakeModel(["DONE: 4100."]);
		const out = await runQuickAnswer({
			messages: USER,
			tools: [],
			makeCall: m.makeCall,
			signal: ac.signal,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("aborted");
	});

	test("the pilot prompt's ANSWER line survives the label exactly once", async () => {
		const m = fakeModel([
			toolCall("read_file", "server.ts"),
			"DONE: Staging uses 4100 and unset uses 3000.\nANSWER: staging=4100 unset=3000",
		]);
		const out = await runQuickAnswer({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: [tool("read_file", [])],
			makeCall: m.makeCall,
		});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.result.content.match(/^ANSWER: /gm)).toHaveLength(1);
		expect(out.result.content).toContain("ANSWER: staging=4100 unset=3000");
	});
});
