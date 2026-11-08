/**
 * #85 gates coverage: no tool path and no model call skips the gates.
 *
 * On 7 Nov 8SO found five paths that skipped a gate, each in a PR that has not
 * merged (release freeze). This suite is the standing check that fails when a
 * new path does the same, and it passes on main today. Gaps that are already
 * known are test.todo, each naming the PR or issue that closes it; flip a todo
 * to test when that lands.
 *
 * MODEL CALLS. Every request that leaves for a model must pass the routing
 * decision (local-only refuses a hosted call) and the privacy decision (a
 * sensitive read holds the turn local). Checked on the shipping paths, against
 * two fakes: a local session endpoint, and a hosted "openrouter.ai" that the
 * fetch spy routes to. Any other host is refused and, if it was not a GET or
 * HEAD, counted as off-box. local-only allows GET and HEAD by design
 * (LOCAL_ONLY_GAPS), so only other methods count as a call that left.
 *   M1 chat(), hosted session, local-first: reaches the hosted fake (positive control)
 *   M2 chat(), hosted session, local-only: refused, nothing leaves
 *   M3 chat(), local session, local-only, text-tool path: nothing leaves
 *   M4 chat(), local session, local-only, native-tool path: nothing leaves
 *   M5 compactNow() (/compact), local session, local-only: the session summarises, nothing leaves
 *   M6 vision interpreter, local session, local-first: the image reaches the hosted fake (positive control)
 *   M7 vision interpreter under local-only: the process wire guard refuses its POST (backstop holds)
 *   M8 every model call site in agent.ts is in MODEL_CALL_SITES (a new one fails here)
 *   todo: compactNow() on a hosted session under local-only (issue 81)
 *   todo: compactNow() on a hosted session after a .env read (issue 81, no fix PR yet)
 *   todo: vision interpreter takes the routing decision at its call site (no fix PR yet)
 *   todo: the small role (compaction, summaries) takes both decisions (fixed by PR 80)
 *
 * TOOLS. Every registered tool must run through the gate (refuseToolCall,
 * then noteToolStart for an allowed batched item), never straight to the
 * executor. The gate is wrapped to record each call and refuse it, so the
 * test also proves a refusal is honoured: no onToolStart, no executor run.
 *   T1 native path, hosted session, every registry category loaded: every offered tool reaches the gate
 *   T2 native path, local session: every tool the request offers reaches the gate
 *   T3 text-tool path, local session: every tool in the catalog reaches the gate
 *   T4 run_batch items: every executor tool reaches the per-item gate
 *   T5 crash-resume replay (runToolForResume): every built-in tool reaches the gate
 *   T6 an allowed batched item is gated before it runs and fires onToolStart (audit)
 *   T7 every executor.execute site in agent.ts is in EXECUTE_SITES (a new one fails here)
 *   T8 every ToolExecutor built outside tests is in EXECUTOR_OWNERS (a new one fails here)
 *   todo: batch tool inner calls take refuseToolCall and noteToolStart (fixed by PR 76)
 *   todo: `8gent mcp` tools/call runs the executor with no mode, hooks or audit (no fix PR yet)
 *
 * STORED FILES (the other three of the five, all in unmerged PRs):
 *   todo: a credential presence check writes nothing (fixed by PR 64)
 *   todo: the history index is 0600 (fixed by PR 77)
 *   todo: stream-rules.json is a protected data file (fixed by PR 79)
 *
 * $HOME is faked; settings.json there carries the routing policy.
 * readPolicyState never reads settings.json under `bun test` (NODE_ENV=test),
 * so the policy is read for real only inside withPolicy().
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { RoutingPolicy } from "../providers/locality";
import { guardFetch } from "../providers/locality-wire";
import type { Agent as AgentT } from "./agent";
import { TOOL_CATEGORIES } from "./tool-registry";

let Agent: typeof import("./agent").Agent;

type Who = "session" | "hosted";
type Body = {
	messages?: Array<{ role: string; content: unknown }>;
	tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
};
type Call = { name: string; args: Record<string, unknown> };
type Json = Record<string, unknown>;

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const HELD = "gates-coverage held this call";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_SILENT_CALLS: "0",
	OPENROUTER_API_KEY: "sk-or-gates-85",
	// Hosted is opt-in (#3710). Granted here, so only the routing and privacy decisions can stop a call.
	EIGHT_ALLOW_HOSTED: "1",
};
let home: string;
let repo: string;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const fakePorts = new Set<string>();
let sessionPort = 0;
let fetchSpy: { mockRestore: () => void } | undefined;
let homeSpy: { mockRestore: () => void } | undefined;
let realFetch: typeof fetch;

/** Model requests each fake received, and requests that tried to leave for any other host. */
const seen: Array<{ who: Who; body: Body }> = [];
const offBox: string[] = [];
/** What the fake model answers with next. Null: "DONE." */
let script: ((who: Who, body: Body) => Response | null) | null = null;

function completion(message: Json, finish: string): Response {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

function fake(who: Who): ReturnType<typeof Bun.serve> {
	const s = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (req.method !== "POST") {
				// The hosted fake lists one free vision model, so the vision interpreter has a hosted pick.
				if (who === "hosted" && path.endsWith("/models")) {
					return Response.json({
						data: [
							{ id: "gates/vision:free", architecture: { input_modalities: ["image", "text"] } },
						],
					});
				}
				return Response.json({ models: [], data: [] });
			}
			if (!/chat\/completions$/.test(path)) return Response.json({});
			const body = (await req.json()) as Body;
			seen.push({ who, body });
			return script?.(who, body) ?? completion({ content: "DONE." }, "stop");
		},
	});
	servers.push(s);
	fakePorts.add(String(s.port));
	return s;
}

function writeSettings(policy: RoutingPolicy): void {
	writeFileSync(
		join(home, ".8gent", "settings.json"),
		JSON.stringify({
			performance: { mode: "balanced", introBanner: "off" },
			voice: { silenceThresholdMs: 1500 },
			routing: { policy },
		}),
	);
}

/** Run fn with the policy read for real from settings.json. */
async function withPolicy<T>(policy: RoutingPolicy, fn: () => Promise<T>): Promise<T> {
	writeSettings(policy);
	const env = process.env as Record<string, string | undefined>;
	const prev = env.NODE_ENV;
	env.NODE_ENV = "production";
	try {
		return await fn();
	} finally {
		if (prev === undefined) Reflect.deleteProperty(env, "NODE_ENV");
		else env.NODE_ENV = prev;
	}
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		prev[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
	}
}

/** Who got model requests while fn ran, and what tried to leave for any other host. */
async function traffic(fn: () => Promise<unknown>): Promise<{ who: Who[]; offBox: string[] }> {
	const s = seen.length;
	const o = offBox.length;
	await fn();
	return { who: seen.slice(s).map((x) => x.who), offBox: offBox.slice(o) };
}

const until = async (ok: () => boolean, ms = 4000): Promise<void> => {
	const end = Date.now() + ms;
	while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "gates85-home-"));
	repo = mkdtempSync(join(tmpdir(), "gates85-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(join(repo, "a.txt"), "a\n");
	writeFileSync(join(repo, ".env"), "API_TOKEN=gates-85-canary\n");
	sessionPort = fake("session").port ?? 0;
	const hosted = fake("hosted");
	realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "openrouter.ai") {
			const path = url.pathname.replace(/^\/api/, "");
			return realFetch(`http://127.0.0.1:${hosted.port}${path}${url.search}`, init);
		}
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
		if (loopback && fakePorts.has(url.port)) return realFetch(input, init);
		const method = String(
			init?.method ?? (input instanceof Request ? input.method : "GET"),
		).toUpperCase();
		if (!loopback && method !== "GET" && method !== "HEAD") offBox.push(`${method} ${url.host}`);
		return Promise.reject(new Error(`gates-coverage blocks ${url.host}`));
	}) as typeof fetch);
	// Bun's os.homedir() ignores a runtime $HOME; agent.ts reads settings through it.
	homeSpy = spyOn(os, "homedir").mockReturnValue(home);
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	ENV.OLLAMA_HOST = `http://127.0.0.1:${sessionPort}`;
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(async () => {
	fetchSpy?.mockRestore();
	homeSpy?.mockRestore();
	for (const s of servers) s.stop(true);
	(await import("../memory/index")).resetMemoryManager();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

function hostedAgent(): AgentT {
	return new Agent({
		model: "gates/hosted-model",
		runtime: "openrouter",
		workingDirectory: repo,
	} as ConstructorParameters<typeof Agent>[0]);
}

function localAgent(model = "m"): AgentT {
	return new Agent({
		model,
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${sessionPort}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** Enough history that /compact has an older middle to summarise. */
function withHistory(agent: AgentT, recentFilePaths: string[] = []): AgentT {
	const history = [{ role: "system", content: "You are a test agent." }];
	for (let i = 0; i < 12; i++) {
		history.push({ role: "user", content: `Step ${i}: describe the api release plan.` });
		history.push({
			role: "assistant",
			content: `Step ${i}: the api ships after the schema check.`,
		});
	}
	const a = agent as unknown as { messageHistory: unknown; recentFilePaths: string[] };
	a.messageHistory = history;
	a.recentFilePaths = recentFilePaths;
	return agent;
}

/** Source lines of a repo file with comment lines dropped. */
function code(file: string): string {
	return readFileSync(join(REPO_ROOT, file), "utf8")
		.split("\n")
		.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
		.join("\n");
}
const count = (src: string, re: RegExp): number => (src.match(new RegExp(re, "g")) ?? []).length;

/**
 * Body of a todo with no assertion on main yet: the code is in an unmerged PR
 * (which carries its own regression test) or the fix is not written. The test
 * name says which. Replace this with the assertion when the fix merges.
 */
const notOnMain = (): never => {
	throw new Error("no assertion on main yet; the test name says what lands it");
};

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

/**
 * Every construct in agent.ts that sends a request to a model, and the decision
 * it passes. A count that changes means a site was added or removed: register
 * it here with the decision it takes and a test above that drives it.
 */
const MODEL_CALL_SITES: Array<{ pattern: RegExp; count: number; gate: string }> = [
	{
		pattern: /createEightAgent\(/,
		count: 6,
		gate: "native turn and its retry, verify, output and continue agents: inside chat(), after decideRoute (M1, M2, M4)",
	},
	{
		pattern: /runTextToolChat\(/,
		count: 2,
		gate: "text-tool turn (definition and its one call): inside chat(), after decideRoute (M3)",
	},
	{
		pattern: /createModel\(/,
		count: 2,
		gate: "compactIfNeeded (inside a turn, after decideRoute) and compactNow (no decision: issue 81 todo) (M5)",
	},
	{
		pattern: /new VisionInterpreter\(/,
		count: 1,
		gate: "inside chat(), but picks its own provider: no decision at the call site (todo), wire guard backstop (M6, M7)",
	},
	{
		pattern: /createClient\(/,
		count: 2,
		gate: "isReady / readiness: GET probes only, no prompt is sent",
	},
	{
		pattern: /[^\w.]fetch\(|modelFetch\(|generateText\(|streamText\(|generateObject\(/,
		count: 0,
		gate: "none in agent.ts",
	},
];

describe("model calls pass the routing and privacy decisions", () => {
	test("M8 registry: every model call site in agent.ts is registered", () => {
		const src = code("packages/eight/agent.ts");
		const got = MODEL_CALL_SITES.map((s) => `${s.pattern.source} x${count(src, s.pattern)}`);
		const want = MODEL_CALL_SITES.map((s) => `${s.pattern.source} x${s.count}`);
		expect(got).toEqual(want);
	});

	test("M1 control: a hosted session under local-first reaches the hosted fake", async () => {
		const t = await traffic(() => withPolicy("local-first", () => hostedAgent().chat("Say hi.")));
		expect(t.who).toContain("hosted");
	}, 30000);

	test("M2 local-only, hosted session: chat() refuses and nothing leaves", async () => {
		let reply = "";
		const t = await traffic(async () => {
			reply = await withPolicy("local-only", () => hostedAgent().chat("Say hi."));
		});
		expect(reply).toContain("local-only");
		expect(t.who).toEqual([]);
		expect(t.offBox).toEqual([]);
	}, 30000);

	for (const [label, textTools] of [
		["M3 text-tool", "1"],
		["M4 native-tool", "0"],
	] as const) {
		test(`${label} path, local session, local-only: the session answers and nothing leaves`, async () => {
			const t = await traffic(() =>
				withEnv({ EIGHT_TEXT_TOOLS: textTools }, () =>
					withPolicy("local-only", () => localAgent().chat("Say hi.")),
				),
			);
			expect(t.who).toContain("session");
			expect(t.who).not.toContain("hosted");
			expect(t.offBox).toEqual([]);
		}, 30000);
	}

	test("M5 compactNow, local session, local-only: the session summarises and nothing leaves", async () => {
		const t = await traffic(() =>
			withPolicy("local-only", async () => {
				const r = await withHistory(localAgent()).compactNow();
				expect(r?.messagesRemoved ?? 0).toBeGreaterThan(0);
			}),
		);
		expect(t.who).toContain("session");
		expect(t.who).not.toContain("hosted");
		expect(t.offBox).toEqual([]);
	}, 30000);

	test.todo(
		"compactNow, hosted session, local-only: the hosted model receives nothing (issue 81, no fix PR yet)",
		async () => {
			const t = await traffic(() =>
				withPolicy("local-only", () => withHistory(hostedAgent()).compactNow()),
			);
			expect(t.who).not.toContain("hosted");
		},
	);

	test.todo(
		"compactNow, hosted session, local-first, a .env read this turn: the hosted model receives nothing (issue 81, no fix PR yet; PR 80 fixes the small role only)",
		async () => {
			const t = await traffic(() =>
				withPolicy("local-first", () =>
					withHistory(hostedAgent(), [join(repo, ".env")]).compactNow(),
				),
			);
			expect(t.who).not.toContain("hosted");
		},
	);

	test.todo(
		"the small role (compaction, summaries) takes the routing and privacy decisions (fixed by PR 80, role-routing-gates.test.ts)",
		notOnMain,
	);

	/** One chat() with an image on a local model that cannot see, so the vision interpreter runs. */
	async function imageTurn(): Promise<{ who: Who[]; offBox: string[] }> {
		const s = seen.length;
		const t = await traffic(async () => {
			await withEnv({ EIGHT_TEXT_TOOLS: "1" }, () =>
				localAgent("gates-text-only").chat("What is in this image?", PNG_1X1, "image/png"),
			);
			// The interpreter is fire-and-forget: give its request time to land.
			await until(() => seen.slice(s).some((x) => x.who === "hosted"), 3000);
		});
		return t;
	}

	test("M6 control: the vision interpreter sends the image to the hosted fake under local-first", async () => {
		const t = await withPolicy("local-first", imageTurn);
		expect(t.who).toContain("hosted");
	}, 30000);

	test("M7 backstop: under local-only the process wire guard refuses the vision interpreter's POST", async () => {
		const spied = globalThis.fetch;
		globalThis.fetch = guardFetch(spied, {
			state: () => ({ policy: "local-only", localHosts: [] }),
			nameOf: (hostPort) => hostPort,
			record: () => null,
			update: () => {},
			notify: () => {},
		});
		try {
			const t = await withPolicy("local-only", imageTurn);
			expect(t.who).not.toContain("hosted");
			expect(t.offBox).toEqual([]);
		} finally {
			globalThis.fetch = spied;
		}
	}, 30000);

	test.todo(
		"the vision interpreter takes the routing decision at its call site: under local-only it sends nothing hosted without the wire guard (no fix PR yet)",
		async () => {
			const t = await withPolicy("local-only", imageTurn);
			expect(t.who).not.toContain("hosted");
		},
	);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A value that satisfies a JSON schema well enough for the SDK to accept the call. */
function sample(schema: unknown): unknown {
	const s = (schema ?? {}) as Json;
	if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
	if ("const" in s) return s.const;
	for (const k of ["anyOf", "oneOf", "allOf"]) {
		const opts = s[k];
		if (Array.isArray(opts) && opts.length > 0) return sample(opts[0]);
	}
	const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
	switch (type) {
		case "string":
			return "x".repeat(Math.max(1, Number(s.minLength ?? 1)));
		case "number":
		case "integer":
			return Number(s.minimum ?? s.exclusiveMinimum ?? 0) + 1;
		case "boolean":
			return false;
		case "array":
			return Array.from({ length: Number(s.minItems ?? 0) }, () => sample(s.items));
		default: {
			const props = (s.properties ?? {}) as Record<string, unknown>;
			const out: Json = {};
			for (const k of (s.required as string[] | undefined) ?? []) out[k] = sample(props[k]);
			return out;
		}
	}
}

/**
 * Valid arguments for tools whose rules a JSON schema cannot carry (a zod refine,
 * a regex), so the SDK accepts the call and it reaches the gate. A tool missing
 * from T1 with "not gated" may need an entry here: an input the SDK rejects
 * never runs, but the test asks for the stronger fact, that the gate saw it.
 */
const VALID_ARGS: Record<string, Json> = {
	travel_search_flights: { origin: "LHR", destination: "JFK", dateFrom: "2026-12-01" },
	make_pptx: { spec: { slides: [{ title: "x" }] } },
	render_video_deck: { spec: { slides: [{ title: "x" }] } },
};
const argsFor = (name: string, schema: unknown): Json =>
	VALID_ARGS[name] ?? (sample(schema) as Json);

type GatedAgent = {
	refuseToolCall: (
		t: string,
		a: Record<string, unknown>,
		plugs?: { args?: Record<string, unknown> },
	) => Promise<string | null>;
	executor: {
		execute: (t: string, a: Record<string, unknown>) => Promise<string>;
		getToolDefinitions: () => unknown[];
	};
	builtInToolNames: () => string[];
	turnToolSet: (p: string, smallTalk: boolean) => Promise<{ textToolAllowlist: string[] }>;
	textToolSpecs: (
		allow: string[],
		smallTalk: boolean,
	) => Array<{ name: string; parameters?: unknown }>;
};

/**
 * Wrap the agent's gate: record every call that reaches it, run the real gate,
 * then refuse. Counts onToolStart and executor runs, which a refused call must
 * never produce.
 */
function instrument(agent: AgentT, refuse = true) {
	const a = agent as unknown as GatedAgent;
	const gated: string[] = [];
	const executed: string[] = [];
	const started: string[] = [];
	const real = a.refuseToolCall.bind(a);
	a.refuseToolCall = async (t, args, plugs) => {
		gated.push(t);
		const r = await real(t, args, plugs);
		if (r != null || !refuse) return r;
		return `Hook blocked tool "${t}": ${HELD}`;
	};
	const exec = a.executor.execute.bind(a.executor);
	a.executor.execute = async (t, args) => {
		executed.push(t);
		return exec(t, args);
	};
	const events = (
		agent as unknown as { events: { onToolStart?: (e: { toolName: string }) => void } }
	).events;
	const prior = events.onToolStart;
	events.onToolStart = (e) => {
		started.push(e.toolName);
		prior?.(e);
	};
	return { a, gated, executed, started };
}

/** The fake model's reply calling these tools: native tool_calls or text tool_call blocks. Null when none are left. */
const CHUNK = 20;
function callReply(batch: Call[], mode: "native" | "text"): Response | null {
	if (batch.length === 0) return null;
	if (mode === "native") {
		return completion(
			{
				content: null,
				tool_calls: batch.map((c, i) => ({
					id: `call_${i}_${c.name}`,
					type: "function",
					function: { name: c.name, arguments: JSON.stringify(c.args) },
				})),
			},
			"tool_calls",
		);
	}
	const blocks = batch.map((c) =>
		["```tool_call", JSON.stringify({ name: c.name, arguments: c.args }), "```"].join("\n"),
	);
	return completion({ content: blocks.join("\n\n") }, "stop");
}

/**
 * The fake model calls every pending tool once, CHUNK at a time, then says DONE.
 * fromBody: the pending list is every tool the first request with tools offers.
 * Turns repeat until the list is empty (a refusal ceiling may end a turn early).
 * Returns every tool name that was offered.
 */
async function callAll(
	agent: AgentT,
	pending: Call[],
	mode: "native" | "text",
	fromBody: boolean,
): Promise<string[]> {
	const offered = new Set(pending.map((c) => c.name));
	let filled = !fromBody;
	script = (_who, body) => {
		if (!filled && (body.tools?.length ?? 0) > 0) {
			filled = true;
			for (const t of body.tools ?? []) {
				const name = t.function?.name;
				if (!name) continue;
				offered.add(name);
				pending.push({ name, args: argsFor(name, t.function?.parameters) });
			}
		}
		return callReply(pending.splice(0, CHUNK), mode);
	};
	try {
		for (let turn = 0; turn < 10; turn++) {
			await agent.chat("Run every tool you have once.");
			if (filled && pending.length === 0) break;
		}
	} finally {
		script = null;
	}
	return [...offered];
}

describe("every registered tool runs through the gate", () => {
	const expectAllGated = (offered: string[], i: ReturnType<typeof instrument>, floor: number) => {
		expect(offered.length).toBeGreaterThanOrEqual(floor);
		const missed = offered.filter((n) => !i.gated.includes(n));
		expect(missed).toEqual([]);
		// A refused call starts nothing and runs nothing.
		expect(i.started).toEqual([]);
		expect(i.executed.filter((n) => offered.includes(n))).toEqual([]);
	};

	test("T1 native path, hosted session, every registry category loaded: every offered tool reaches the gate", async () => {
		const agent = hostedAgent();
		// Load every category, as discover_tools would over later turns, so the one request offers them all.
		const registry = (
			agent as unknown as { toolRegistry: { loadCategory: (c: string) => string[] } }
		).toolRegistry;
		for (const c of Object.keys(TOOL_CATEGORIES)) registry.loadCategory(c);
		const i = instrument(agent);
		const offered = await withPolicy("local-first", () => callAll(agent, [], "native", true));
		expectAllGated(offered, i, 40);
	}, 120000);

	test("T2 native path, local session: every offered tool reaches the gate", async () => {
		const agent = localAgent();
		const i = instrument(agent);
		const offered = await withEnv({ EIGHT_TEXT_TOOLS: "0" }, () =>
			callAll(agent, [], "native", true),
		);
		expectAllGated(offered, i, 10);
	}, 120000);

	test("T3 text-tool path, local session: every catalog tool reaches the gate", async () => {
		const agent = localAgent();
		const i = instrument(agent);
		const offered = await withEnv({ EIGHT_TEXT_TOOLS: "1" }, async () => {
			const { textToolAllowlist } = await i.a.turnToolSet("ollama", false);
			const pending = i.a
				.textToolSpecs(textToolAllowlist, false)
				.map((s) => ({ name: s.name, args: argsFor(s.name, s.parameters) }));
			return callAll(agent, pending, "text", false);
		});
		expectAllGated(offered, i, 10);
	}, 120000);

	test("T4 run_batch: every executor tool reaches the per-item gate", async () => {
		await withEnv({ EIGHT_RUN_BATCH: "1" }, async () => {
			const agent = localAgent();
			const i = instrument(agent);
			const defs = i.a.executor.getToolDefinitions() as Array<{
				function?: { name?: string; parameters?: unknown };
			}>;
			const items = defs
				.map((d) => ({
					tool: String(d.function?.name),
					args: argsFor(String(d.function?.name), d.function?.parameters),
				}))
				.filter((x) => x.tool !== "run_batch");
			expect(items.length).toBeGreaterThanOrEqual(20);
			// One item per batch: a refused write cancels the writes after it, so they would never be asked.
			for (const item of items) await i.a.executor.execute("run_batch", { items: [item] });
			const missed = items.map((x) => x.tool).filter((n) => !i.gated.includes(n));
			expect(missed).toEqual([]);
			expect(i.started).toEqual([]);
			expect(i.executed.filter((n) => n !== "run_batch")).toEqual([]);
		});
	}, 60000);

	test("T5 crash-resume replay: every built-in tool reaches the gate", async () => {
		const agent = localAgent();
		const i = instrument(agent);
		const names = i.a.builtInToolNames();
		expect(names.length).toBeGreaterThanOrEqual(20);
		for (const n of names) {
			const out = await (
				agent as unknown as {
					runToolForResume: (t: string, a: Json) => Promise<string>;
				}
			).runToolForResume(n, {});
			expect(out).toContain(HELD);
		}
		expect(names.filter((n) => !i.gated.includes(n))).toEqual([]);
		expect(i.executed).toEqual([]);
	}, 60000);

	test("T6 an allowed batched item is gated before it runs and fires onToolStart", async () => {
		await withEnv({ EIGHT_RUN_BATCH: "1" }, async () => {
			const agent = localAgent();
			const i = instrument(agent, false);
			const order: string[] = [];
			const gate = i.a.refuseToolCall;
			i.a.refuseToolCall = async (t, args, plugs) => {
				order.push(`gate ${t}`);
				return gate(t, args, plugs);
			};
			const exec = i.a.executor.execute;
			i.a.executor.execute = async (t, args) => {
				order.push(`run ${t}`);
				return exec(t, args);
			};
			await i.a.executor.execute("run_batch", {
				items: [
					{ tool: "read_file", args: { path: "a.txt" } },
					{ tool: "list_files", args: { path: "." } },
				],
			});
			for (const t of ["read_file", "list_files"]) {
				const g = order.indexOf(`gate ${t}`);
				expect(g).toBeGreaterThanOrEqual(0);
				const r = order.indexOf(`run ${t}`);
				if (r >= 0) expect(g).toBeLessThan(r);
				expect(i.started).toContain(t);
			}
		});
	}, 60000);

	/**
	 * Every place agent.ts runs a tool on the executor, and the gate in front of it.
	 * A new site fails here until it is registered with its gate and a test.
	 */
	const EXECUTE_SITES: Array<{ marker: RegExp; gate: string }> = [
		{
			marker:
				/execute: \(args: Record<string, unknown>\) => this\.executor\.execute\(t\.name, args\)/,
			gate: "native extension tools: wrapped by gateTools with every offered tool (T1, T2)",
		},
		{
			marker: /result = await this\.executor\.execute\(toolName, args\)/,
			gate: "text-tool run(): refuseToolCall first (T3)",
		},
		{
			marker:
				/runInReadScope\(this\.readScope, \(\) => this\.executor\.execute\(toolName, args\)\)/,
			gate: "runToolForResume: refuseToolCall first (T5)",
		},
		{
			marker: /const result = await this\.executor\.execute\(dispatch\.tool, dispatch\.args\)/,
			gate: "pre-fetch: refuseToolCall on the line before",
		},
	];

	test("T7 registry: every executor.execute site in agent.ts is registered", () => {
		const src = code("packages/eight/agent.ts");
		expect(count(src, /this\.executor\.execute\(/)).toBe(EXECUTE_SITES.length);
		for (const s of EXECUTE_SITES)
			expect({ site: s.gate, found: s.marker.test(src) }).toEqual({ site: s.gate, found: true });
		// The native gate wraps every offered tool, and the agent hands the SDK that gate.
		expect(code("packages/ai/agent.ts")).toMatch(
			/config\.gateToolCall\s*\?\s*gateTools\(offered, config\.gateToolCall/,
		);
		expect(src).toMatch(
			/gateToolCall: async \(event\) => \{\s*const plugged[\s\S]*?this\.refuseToolCall\(event\.toolName/,
		);
		// run_batch items take the agent's gate.
		expect(src).toMatch(
			/setItemGate\(async \(t, a\) => \{\s*const refusal = await this\.refuseToolCall\(t, a\)/,
		);
	});

	/**
	 * Every ToolExecutor built outside tests, and what gates its calls. A new owner
	 * fails here until it is registered.
	 */
	const EXECUTOR_OWNERS: Record<string, string> = {
		"packages/eight/agent.ts": "the agent: refuseToolCall on every path (T1 to T7)",
		"packages/eight/run.ts": "tool names only, never executes",
		"packages/orchestration/index.ts":
			"harness-run scope test command for a finished child; executor policy only, not a model call",
		"packages/mcp/server.ts":
			"`8gent mcp` tools/call: executor policy only, no mode, hooks or audit (todo below)",
		"packages/eight/scripts/desktop-act-dry.ts": "dev script, not shipped",
		"packages/decide/eval/locate-run.ts": "eval harness, not shipped",
		"packages/ast-index/eval/real-queries.ts": "eval harness, not shipped",
	};

	test("T8 registry: every ToolExecutor owner outside tests is registered", () => {
		const owners: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir)) {
				if (e === "node_modules" || e.startsWith(".")) continue;
				const p = join(dir, e);
				if (statSync(p).isDirectory()) {
					if (e === "__tests__" || e === "fixtures") continue;
					walk(p);
				} else if (/\.tsx?$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) {
					if (/new ToolExecutor\(/.test(code(relative(REPO_ROOT, p))))
						owners.push(relative(REPO_ROOT, p));
				}
			}
		};
		for (const d of ["packages", "apps", "bin"]) walk(join(REPO_ROOT, d));
		expect(owners.sort()).toEqual(Object.keys(EXECUTOR_OWNERS).sort());
	});

	test.todo(
		"the batch tool's inner calls each take refuseToolCall and noteToolStart (fixed by PR 76, batch-read.test.ts)",
		notOnMain,
	);

	test.todo(
		"`8gent mcp` tools/call takes the mode check, PreToolUse hooks and the session audit row (packages/mcp/server.ts, no fix PR yet)",
		notOnMain,
	);
});

// ---------------------------------------------------------------------------
// Stored files: the other three of the five gaps, all in unmerged PRs
// ---------------------------------------------------------------------------

describe("stored files and rules files", () => {
	test.todo(
		"a credential presence check is a pure read: auth-profiles.json is not rewritten and the round-robin does not move (fixed by PR 64, auth-rotation-peek.test.ts)",
		notOnMain,
	);
	test.todo(
		"the history search index file is 0600 (fixed by PR 77, db-file-mode.test.ts)",
		notOnMain,
	);
	test.todo(
		"stream-rules.json is a protected data file and a startup code file, so a tool cannot write it (fixed by PR 79, stream-rules-protected.test.ts)",
		notOnMain,
	);
});
