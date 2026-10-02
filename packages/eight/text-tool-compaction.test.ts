/**
 * #3267: a long text-tool session compacts.
 *
 * The text-tool turn (ollama, lmstudio, llama-server: the default local
 * providers) used to return before the post-turn block that runs both
 * compactors, so a local session grew without bound and neither compactor
 * ever made a summary call. Both turn paths now share one post-turn
 * compaction step.
 *
 * Every turn here runs on the text-tool path against a fake OpenAI-compatible
 * endpoint. The compactor is the agent's own; its summary call goes to the
 * same fake endpoint, which answers with a sentinel. The one thing the test
 * sets is the context window, so a short session crosses the threshold.
 * $HOME is faked so the operator's memories, sessions and config stay out.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
let ProactiveCompression: typeof import("./compaction").ProactiveCompression;
let twoStageTokens: typeof import("./two-stage-compactor").estimateMessageTokens;

type Msg = { role: string; content: unknown };
type Body = { model?: string; messages: Msg[]; auth?: string | null };

const SUMMARY = "SENTINEL_3267_text_tool_summary";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "1",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];

// Reroutes (#3267): the fake endpoint 404s `goneModel` as Ollama does for a
// model that is not pulled, and local model detection reports what `detected`
// says: the real host, one LM Studio model, or nothing installed at all.
let goneModel: string | null = null;
let detected: "real" | "lmstudio" | "none" = "real";
const LM_MODEL = "lm-studio-model";

/** A summariser call: a bare prompt (no system message) over a serialised conversation. */
function isSummaryRequest(body: Body): boolean {
	return (
		!body.messages.some((m) => m.role === "system") &&
		JSON.stringify(body.messages).includes("<conversation>")
	);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "tt3267-home-"));
	repo = mkdtempSync(join(tmpdir(), "tt3267-repo-"));
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
	// mock.module is permanent for the process (bun has no undo for it), so it
	// delegates to the real detector unless a test here sets `detected`: other
	// test files sharing the process see the real behaviour.
	const detect = await import("../orchestration/local-model-detect");
	const real = { ...detect };
	mock.module("../orchestration/local-model-detect", () => ({
		...real,
		detectLocalModels: async () =>
			detected === "lmstudio"
				? [{ provider: "lmstudio", model: LM_MODEL, score: 10, toolCapable: true }]
				: detected === "none"
					? []
					: real.detectLocalModels(),
	}));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as Body;
			body.auth = req.headers.get("authorization");
			bodies.push(body);
			if (goneModel && body.model === goneModel) {
				return Response.json(
					{ error: { message: `model '${goneModel}' not found, try pulling it first` } },
					{ status: 404 },
				);
			}
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
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
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

function build(apiKey?: string): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		apiKey,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** Every request body one chat() turn sends, model turn first. */
async function turn(agent: AgentT, text: string): Promise<Body[]> {
	const start = bodies.length;
	await agent.chat(text);
	const sent = bodies.slice(start);
	if (sent.length === 0) throw new Error(`no model request for "${text}"`);
	return sent;
}

const NOTES = Array.from(
	{ length: 40 },
	(_, i) => `Release note ${i}: the api module ships after the schema check passes.`,
).join(" ");

/** A long local session: eight text-tool turns of bulky history. */
async function longSession(agent: AgentT): Promise<void> {
	for (let i = 1; i <= 8; i++) {
		const sent = await turn(
			agent,
			`Using typescript, describe step ${i} of the api release plan for the release team in two sentences. ${NOTES}`,
		);
		// The default window is far above this session: nothing compacts yet.
		expect(sent.some(isSummaryRequest)).toBe(false);
	}
}

/** ProactiveCompression's token count, read off its public stage boundary (stage "none" below 0.75). */
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
 * The text-tool turn that crosses the threshold compacts after it, and the
 * next text-tool turn carries the summary in place of the compacted middle.
 */
async function compactsAndCarries(agent: AgentT): Promise<void> {
	const before = agent.getMessageHistory().length;
	const compacting = await turn(
		agent,
		"Using typescript, list the open release risks for the team.",
	);
	expect(compacting.some(isSummaryRequest)).toBe(true);
	// The history really shrank: the turn added two messages and compaction removed more.
	expect(agent.getMessageHistory().length).toBeLessThan(before);
	const [next] = await turn(agent, "Using typescript, what is the next release step for the team?");
	const carrying = next!.messages.filter(
		(m) => m.role !== "system" && JSON.stringify(m.content).includes(SUMMARY),
	);
	expect(carrying.length).toBe(1);
}

describe("text-tool turns run the post-turn compaction (#3267)", () => {
	test("ProactiveCompression compacts a long text-tool session", async () => {
		const agent = build();
		await longSession(agent);
		const used = proactiveTokens(agent.getMessageHistory());
		Reflect.set(
			agent,
			"compaction",
			new ProactiveCompression({ contextWindow: Math.floor(used / 0.82), keepRecentTokens: 200 }),
		);
		await compactsAndCarries(agent);
	}, 60_000);

	test("the two-stage compactor compacts a long text-tool session", async () => {
		process.env["8GENT_TWO_STAGE_COMPACT"] = "1";
		try {
			const agent = build();
			await longSession(agent);
			Reflect.set(agent, "compaction", new ProactiveCompression({ enabled: false }));
			const used = twoStageTokens(agent.getMessageHistory());
			Reflect.set(agent, "compactionContextWindow", Math.floor(used / 0.85));
			await compactsAndCarries(agent);
		} finally {
			process.env["8GENT_TWO_STAGE_COMPACT"] = "0";
		}
	}, 60_000);
});

describe("text-tool compaction follows a cross-provider reroute (#3267)", () => {
	/**
	 * The pinned Ollama model disappears mid-session, so the compacting turn
	 * reroutes to LM Studio. Its summary request must go to LM Studio with the
	 * model that answered (LM Studio's client sends its bearer key; Ollama's
	 * sends none), not to the pinned Ollama model, which would 404 and leave
	 * the session uncompacted.
	 */
	async function reroutesThenCompacts(agent: AgentT): Promise<void> {
		goneModel = "m";
		detected = "lmstudio";
		const start = bodies.length;
		try {
			await compactsAndCarries(agent);
		} finally {
			goneModel = null;
			detected = "real";
		}
		const summaries = bodies.slice(start).filter(isSummaryRequest);
		expect(summaries.length).toBeGreaterThan(0);
		for (const s of summaries) {
			expect(s.model).toBe(LM_MODEL);
			expect(s.auth).toBe("Bearer lm-studio");
		}
	}

	test("ProactiveCompression summarises on the provider that answered", async () => {
		const agent = build();
		await longSession(agent);
		const used = proactiveTokens(agent.getMessageHistory());
		Reflect.set(
			agent,
			"compaction",
			new ProactiveCompression({ contextWindow: Math.floor(used / 0.82), keepRecentTokens: 200 }),
		);
		await reroutesThenCompacts(agent);
	}, 60_000);

	test("the two-stage summariser follows the reroute, not the first turn's provider", async () => {
		process.env["8GENT_TWO_STAGE_COMPACT"] = "1";
		try {
			const agent = build();
			// The long session builds the two-stage compactor on the pinned Ollama provider.
			await longSession(agent);
			Reflect.set(agent, "compaction", new ProactiveCompression({ enabled: false }));
			const used = twoStageTokens(agent.getMessageHistory());
			Reflect.set(agent, "compactionContextWindow", Math.floor(used / 0.85));
			await reroutesThenCompacts(agent);
		} finally {
			process.env["8GENT_TWO_STAGE_COMPACT"] = "0";
		}
	}, 60_000);
});

describe("text-tool compaction sends no session key, and skips failed turns (#3267)", () => {
	/** A long session whose ProactiveCompression window the next turn crosses. */
	async function pressed(apiKey?: string): Promise<AgentT> {
		const agent = build(apiKey);
		await longSession(agent);
		const used = proactiveTokens(agent.getMessageHistory());
		Reflect.set(
			agent,
			"compaction",
			new ProactiveCompression({ contextWindow: Math.floor(used / 0.82), keepRecentTokens: 200 }),
		);
		return agent;
	}

	test("a cloud key on a local session never reaches the local host", async () => {
		// Hosts pass OPENROUTER_API_KEY whatever the runtime. The text-tool turn
		// sends no Authorization, so neither may its compaction call.
		const KEY = "sk-or-SENTINEL-3267";
		const agent = await pressed(KEY);
		const start = bodies.length;
		await compactsAndCarries(agent);
		const sent = bodies.slice(start);
		expect(sent.some(isSummaryRequest)).toBe(true);
		for (const b of sent) expect(b.auth ?? "").not.toContain(KEY);
	}, 60_000);

	test("a failed text-tool turn returns its error without compacting", async () => {
		const agent = await pressed();
		goneModel = "m";
		detected = "none";
		try {
			const start = bodies.length;
			const before = agent.getMessageHistory().length;
			await agent.chat("Using typescript, list the open release risks for the team.");
			// No model anywhere: the turn fails, and no summary call follows it.
			expect(bodies.slice(start).some(isSummaryRequest)).toBe(false);
			expect(agent.getMessageHistory().length).toBeGreaterThan(before);
		} finally {
			goneModel = null;
			detected = "real";
		}
	}, 60_000);
});
