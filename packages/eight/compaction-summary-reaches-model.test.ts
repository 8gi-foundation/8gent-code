/**
 * #3263: a compacted session keeps its summary in front of the model.
 *
 * All three compactors replace the older history with a summary. They used to
 * add it as a second `system` message, and every request builder keeps only
 * the first system message (the byte-stable prompt), so after a compaction the
 * model saw the prompt plus the kept tail and no record of what was compacted.
 * The summary now travels as a harness context note (the #3260 shape).
 *
 * Like harness-notes-reach-model.test.ts this drives the shipping chat() path
 * against a fake OpenAI-compatible endpoint and asserts on request bodies. The
 * compaction itself is real: the agent's own compactor runs after a turn and
 * its summary call goes to the same fake endpoint, which answers with a
 * sentinel. The one thing the test sets is the context window, so a short
 * session crosses the compaction threshold. $HOME is faked so the operator's
 * memories, sessions and config stay out of the test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
let ProactiveCompression: typeof import("./compaction").ProactiveCompression;
let twoStageTokens: typeof import("./two-stage-compactor").estimateMessageTokens;
let CONTEXT_NOTE_HEADER: string;

type Msg = { role: string; content: unknown };
type Body = { messages: Msg[] };

const SUMMARY = "SENTINEL_3263_compaction_summary";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];

/** A summariser call: a bare prompt (no system message) over a serialised conversation. */
function isSummaryRequest(body: Body): boolean {
	return (
		!body.messages.some((m) => m.role === "system") &&
		JSON.stringify(body.messages).includes("<conversation>")
	);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "compact3263-home-"));
	repo = mkdtempSync(join(tmpdir(), "compact3263-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	({ ProactiveCompression } = await import("./compaction"));
	({ estimateMessageTokens: twoStageTokens } = await import("./two-stage-compactor"));
	({ CONTEXT_NOTE_HEADER } = await import("./context-note"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as Body;
			bodies.push(body);
			const content = isSummaryRequest(body) ? SUMMARY : "Done.";
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

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** The first request body the model receives for one chat() turn. */
async function turn(agent: AgentT, text: string): Promise<Body> {
	const start = bodies.length;
	await agent.chat(text);
	const body = bodies[start];
	if (!body) throw new Error(`no model request for "${text}"`);
	return body;
}

/** Bulk for the warm-up turns, so one later turn moves the token ratio by a few percent at most. */
const NOTES = Array.from(
	{ length: 40 },
	(_, i) => `Release note ${i}: the api module ships after the schema check passes.`,
).join(" ");

/**
 * Enough turns that every compactor has an older middle to summarise. Returns
 * the last request body, the prefix the post-compaction turn must match.
 */
async function warmUp(agent: AgentT): Promise<Body> {
	let last!: Body;
	for (let i = 1; i <= 5; i++) {
		last = await turn(
			agent,
			`Using typescript, describe step ${i} of the api release plan for the release team in two sentences. ${NOTES}`,
		);
	}
	return last;
}

/**
 * The history's token count as ProactiveCompression measures it. Its estimator
 * is private, so read it off the public stage boundary: the stage is "none"
 * exactly when used / window < 0.75 (the default 0.25 threshold).
 */
function proactiveTokens(history: Array<{ role: string; content: string }>): number {
	let lo = 1;
	let hi = 10_000_000;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (new ProactiveCompression({ contextWindow: mid }).getStage(history) === "none") hi = mid;
		else lo = mid + 1;
	}
	return Math.floor(lo * 0.75);
}

/**
 * Size ProactiveCompression's window so the current history sits at `ratio`
 * of it. The next turn adds a few dozen tokens, well inside the stage band.
 */
function pressProactive(agent: AgentT, ratio: number): void {
	const used = proactiveTokens(agent.getMessageHistory());
	Reflect.set(
		agent,
		"compaction",
		// A short session has less than the default 20k tokens to keep verbatim.
		new ProactiveCompression({ contextWindow: Math.floor(used / ratio), keepRecentTokens: 200 }),
	);
}

/** Non-system messages whose text contains `needle`. */
function carrying(body: Body, needle: string): Msg[] {
	return body.messages.filter(
		(m) => m.role !== "system" && JSON.stringify(m.content).includes(needle),
	);
}

const system = (b: Body) => JSON.stringify(b.messages.filter((m) => m.role === "system"));

/**
 * Run the compacting turn, then the turn that must carry the summary on the
 * path under test. Only the native path compacts (the text-tool turn returns
 * before the post-turn block), so the compacting turn always runs native; the
 * history it leaves is what either request builder sends next.
 */
async function compactThenAsk(
	agent: AgentT,
	marker: string,
	textTools: string,
	prefix: Body,
): Promise<void> {
	const start = bodies.length;
	process.env.EIGHT_TEXT_TOOLS = "0";
	try {
		await turn(agent, "Using typescript, list the open release risks for the team.");
	} finally {
		process.env.EIGHT_TEXT_TOOLS = textTools;
	}
	// The compactor ran after that turn and asked the fake endpoint for a summary.
	expect(bodies.slice(start).some(isSummaryRequest)).toBe(true);
	const after = await turn(agent, "Using typescript, what is the next release step for the team?");
	const notes = carrying(after, SUMMARY);
	expect(notes.length).toBe(1);
	const text = JSON.stringify(notes[0]?.content);
	expect(text).toContain(marker);
	expect(text).toContain(CONTEXT_NOTE_HEADER);
	// Compaction rewrites history, never the prompt: the prefix stays byte-identical.
	expect(system(after)).toBe(system(prefix));
}

// Both shipping request builders send the compacted history: the text-tool
// path for local servers and the native-tool path.
for (const [label, textTools] of [
	["text-tool (local)", "1"],
	["native-tool (full prompt)", "0"],
] as const) {
	describe(`compaction summaries reach the request body, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
			process.env["8GENT_TWO_STAGE_COMPACT"] = "0";
		});

		test("summarize stage (Terminus-2)", async () => {
			const agent = build();
			const prefix = await warmUp(agent);
			pressProactive(agent, 0.82);
			await compactThenAsk(agent, "[Proactive Compression: Terminus-2]", textTools, prefix);
		}, 60_000);

		test("simplify stage (single-pass summary)", async () => {
			const agent = build();
			const prefix = await warmUp(agent);
			pressProactive(agent, 0.91);
			await compactThenAsk(agent, "[Context Compaction Summary]", textTools, prefix);
		}, 60_000);

		test("two-stage compactor", async () => {
			process.env["8GENT_TWO_STAGE_COMPACT"] = "1";
			try {
				const agent = build();
				const prefix = await warmUp(agent);
				// Only the two-stage compactor acts in this test.
				Reflect.set(agent, "compaction", new ProactiveCompression({ enabled: false }));
				const used = twoStageTokens(agent.getMessageHistory());
				Reflect.set(agent, "compactionContextWindow", Math.floor(used / 0.85));
				await compactThenAsk(agent, "[Two-Stage Compaction Summary]", textTools, prefix);
			} finally {
				process.env["8GENT_TWO_STAGE_COMPACT"] = "0";
			}
		}, 60_000);
	});
}
