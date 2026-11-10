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
 * (LOCAL_ONLY_GAPS), so only other methods count as a call that left. Transports
 * other than fetch are trapped too (passport-net-trap.ts for node:http, https,
 * net, tls and dns, plus WebSocket and a spawned curl, wget, nc or ssh): any
 * use is counted as off-box and refused.
 *   N0 control: the transport trap records each of those transports
 *   M1 chat(), hosted session, local-first: reaches the hosted fake (positive control)
 *   M2 chat(), hosted session, local-only: refused, nothing leaves
 *   M3 chat(), local session, local-only, text-tool path: nothing leaves
 *   M4 chat(), local session, local-only, native-tool path: nothing leaves
 *   M5 compactNow() (/compact), local session, local-only: the session summarises, nothing leaves
 *   M6 vision interpreter, local session, local-first: the image reaches the hosted fake (positive control)
 *   M7 vision interpreter under local-only: the process wire guard refuses its POST (backstop holds)
 *   M8 agent.ts only: every model call reference in agent.ts is in MODEL_CALL_SITES (a new one,
 *      an alias or a raw transport fails here); helpers in other files are covered by M1 to M7 only
 *   todo: compactNow() on a hosted session under local-only (issue 81)
 *   todo: compactNow() on a hosted session after a .env read (issue 81, no fix PR yet)
 *   todo: vision interpreter takes the routing decision at its call site (issue 88)
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
 *   T7 every reference to this.executor in agent.ts is classified: a run (execute, runCommand)
 *      must be a registered site with its gate in the marker; an alias or unknown use fails
 *   T9 pre-fetch (tryRunPreToolRouter): every router strategy's tool reaches the gate, a refusal runs nothing
 *   T8 every ToolExecutor built outside tests, aliased imports included, is in EXECUTOR_OWNERS
 *   todo: batch tool inner calls take refuseToolCall and noteToolStart (fixed by PR 76)
 *   todo: `8gent mcp-server` tools/call runs the executor with no mode, hooks or audit (issue 89)
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
import * as childProcess from "node:child_process";
import dns from "node:dns";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import tls from "node:tls";
import { rmRetry } from "../../tests/rm-retry";
import type { RoutingPolicy } from "../providers/locality";
import { installLocalityGuard } from "../providers/locality-wire";
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
	const l = trapLog().length;
	await fn();
	const trapped = trapLog()
		.slice(l)
		.map((name) => `trap ${name}`);
	return { who: seen.slice(s).map((x) => x.who), offBox: [...offBox.slice(o), ...trapped] };
}

/** Names passport-net-trap.ts wrote: one line per node:http, https, net, tls or dns use. */
let netLog = "";
const trapLog = (): string[] =>
	netLog && existsSync(netLog) ? readFileSync(netLog, "utf8").split("\n").filter(Boolean) : [];

/** A spawned command that talks to the network on its own. */
const NET_COMMAND = /(^|[\s/;&|(])(curl|wget|nc|ncat|socat|ssh|scp|telnet)(\s|$)/;
const spawnText = (args: unknown[]): string =>
	args
		.flatMap((a) =>
			Array.isArray(a)
				? a
				: typeof a === "object" && a && "cmd" in a
					? (a as { cmd: unknown[] }).cmd
					: [a],
		)
		.filter((a) => typeof a === "string")
		.join(" ");

/** Originals the transport trap replaces, restored in afterAll. */
const restore: Array<() => void> = [];

/**
 * Trap every transport that is not fetch. passport-net-trap.ts replaces node:http,
 * https, net, tls and dns with functions that log and throw; WebSocket and spawned
 * network commands are trapped here, and recorded straight into offBox.
 */
async function installTransportTrap(): Promise<void> {
	const mods = [
		[net, ["connect", "createConnection"]],
		[tls, ["connect"]],
		[http, ["request", "get"]],
		[https, ["request", "get"]],
		[dns, ["lookup"]],
	] as const;
	for (const [mod, keys] of mods) {
		for (const k of keys) {
			const m = mod as unknown as Record<string, unknown>;
			const orig = m[k];
			restore.push(() => {
				m[k] = orig;
			});
		}
	}
	const fetchBefore = globalThis.fetch;
	netLog = join(home, "net-trap.log");
	process.env.PASSPORT_NET_LOG = netLog;
	await import("./passport-net-trap");
	// The trap replaced fetch as well; the fetch spy below is the fetch check.
	globalThis.fetch = fetchBefore;

	const g = globalThis as unknown as { WebSocket?: unknown };
	const ws = g.WebSocket;
	g.WebSocket = class {
		constructor(url: unknown) {
			offBox.push(`WebSocket ${String(url)}`);
			throw new Error("gates-coverage blocks WebSocket");
		}
	};
	restore.push(() => {
		g.WebSocket = ws;
	});
	const cp = childProcess as unknown as Record<string, (...a: unknown[]) => unknown>;
	for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
		const orig = cp[k];
		const trapped = (...a: unknown[]) => {
			const text = spawnText(a);
			if (NET_COMMAND.test(text)) {
				offBox.push(`spawn ${text.slice(0, 60)}`);
				throw new Error("gates-coverage blocks a network command");
			}
			return orig(...a);
		};
		try {
			cp[k] = trapped;
			restore.push(() => {
				cp[k] = orig;
			});
		} catch {
			spyOn(childProcess, k as "spawn").mockImplementation(trapped as never);
		}
	}
	for (const k of ["spawn", "spawnSync"] as const) {
		const orig = Bun[k].bind(Bun) as (...a: unknown[]) => unknown;
		const spy = spyOn(Bun, k).mockImplementation(((...a: unknown[]) => {
			const text = spawnText(a);
			if (NET_COMMAND.test(text)) {
				offBox.push(`spawn ${text.slice(0, 60)}`);
				throw new Error("gates-coverage blocks a network command");
			}
			return orig(...a);
		}) as never);
		restore.push(() => spy.mockRestore());
	}
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
	await installTransportTrap();
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
	globalThis.fetch = realFetch;
	for (const r of restore.reverse()) r();
	Reflect.deleteProperty(process.env, "PASSPORT_NET_LOG");
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
 * Every reference in agent.ts to something that sends a request to a model, and
 * the decision it passes. References, not calls: an alias (`const mk =
 * createEightAgent`) adds one and fails here, as does any fetch form
 * (`fetch(`, `globalThis.fetch(`, `Bun.fetch(`) or raw transport. agent.ts only:
 * a model call in another file is covered by the traffic tests (M1 to M7) alone.
 * A count that changes means a site was added or removed: register it here with
 * the decision it takes and a test that drives it.
 */
const MODEL_CALL_SITES: Array<{ pattern: RegExp; count: number; gate: string }> = [
	{
		pattern: /\bcreateEightAgent\b/,
		count: 7,
		gate: "import, then the native turn and its retry, verify, output and continue agents: inside chat(), after decideRoute (M1, M2, M4)",
	},
	{
		pattern: /\brunTextToolChat\b/,
		count: 2,
		gate: "text-tool turn (definition and its one call): inside chat(), after decideRoute (M3)",
	},
	{
		pattern: /\bcreateModel\b/,
		count: 3,
		gate: "import, compactIfNeeded (inside a turn, after decideRoute) and compactNow (no decision: issue 81 todo) (M5)",
	},
	{
		pattern: /\bcompactHistory(Now)?\b/,
		count: 4,
		gate: "imports, and the two compaction passes above",
	},
	{
		pattern: /\bVisionInterpreter\b/,
		count: 2,
		gate: "import, and one use inside chat() that picks its own provider: no decision at the call site (issue 88 todo), wire guard backstop (M6, M7)",
	},
	{
		pattern: /\bcreateClient\b/,
		count: 3,
		gate: "import, and isReady / readiness: GET probes only, no prompt is sent",
	},
	{
		pattern: /\bfetch\b/,
		count: 1,
		gate: 'the words "fetch failed" in an error-message regex; any fetch, globalThis.fetch or Bun.fetch call adds one',
	},
	{
		pattern:
			/\b(modelFetch|modelFetchAsFetch|generateText|streamText|generateObject|streamObject|WebSocket)\b|node:(http|https|net|tls|dgram)|child_process|\bBun\.(spawn|spawnSync|connect|\$)/,
		count: 0,
		gate: "none in agent.ts",
	},
];

describe("model calls pass the routing and privacy decisions", () => {
	test("M8 registry, agent.ts only: every model call reference in agent.ts is registered", () => {
		const src = code("packages/eight/agent.ts");
		const got = MODEL_CALL_SITES.map((s) => `${s.pattern.source} x${count(src, s.pattern)}`);
		const want = MODEL_CALL_SITES.map((s) => `${s.pattern.source} x${s.count}`);
		expect(got).toEqual(want);
	});

	test("N0 control: the transport trap records node:http, https, net, tls, WebSocket and spawned curl", async () => {
		const tries: Array<() => unknown> = [
			() => http.request("http://openrouter.ai/api/v1/chat/completions", { method: "POST" }),
			() => https.request("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }),
			() => net.connect(443, "openrouter.ai"),
			() => tls.connect(443, "openrouter.ai"),
			() => new WebSocket("wss://openrouter.ai/ws"),
			() => Bun.spawn(["curl", "-X", "POST", "https://openrouter.ai/api/v1/chat/completions"]),
			() => childProcess.spawn("bash", ["-c", "curl -X POST https://openrouter.ai"]),
		];
		const t = await traffic(async () => {
			for (const go of tries) {
				try {
					go();
				} catch {
					// every trap throws; the record is what is checked
				}
			}
		});
		const text = t.offBox.join("\n");
		for (const want of [
			"http.request",
			"https.request",
			"net.connect",
			"tls.connect",
			"WebSocket",
			"spawn curl",
			"spawn bash -c curl",
		])
			expect(text).toContain(want);
		expect(t.who).toEqual([]);
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
		// The production guard: installLocalityGuard with defaultWireDeps, which reads
		// settings.json for itself (withPolicy writes local-only there). It wraps the fetch spy.
		const spied = globalThis.fetch;
		try {
			const t = await withPolicy("local-only", async () => {
				installLocalityGuard(true);
				expect(globalThis.fetch).not.toBe(spied);
				return imageTurn();
			});
			expect(t.who).not.toContain("hosted");
			expect(t.offBox).toEqual([]);
		} finally {
			globalThis.fetch = spied;
		}
	}, 30000);

	test.todo(
		"the vision interpreter takes the routing decision at its call site: under local-only it sends nothing hosted without the wire guard (issue 88, no fix PR yet)",
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
	 * Every place agent.ts runs something on the executor, with its gate in the
	 * marker, so deleting the gate fails here as well as in the behavioural test.
	 * A new run site fails until it is registered with its gate and a test.
	 */
	const RUN_SITES: Array<{ marker: RegExp; gate: string }> = [
		{
			marker:
				/execute: \(args: Record<string, unknown>\) => this\.executor\.execute\(t\.name, args\)/,
			gate: "native extension tools: wrapped by gateTools with every offered tool (T1, T2; the wrap is asserted below)",
		},
		{
			marker:
				/const refusal = await this\.refuseToolCall\(toolName, args\);[\s\S]{0,4000}?result = await this\.executor\.execute\(toolName, args\)/,
			gate: "text-tool run(): refuseToolCall first (T3)",
		},
		{
			marker:
				/const refusal = await this\.refuseToolCall\(toolName, args\);\s*if \(refusal\) return refusal;[\s\S]{0,300}?this\.executor\.execute\(toolName, args\)/,
			gate: "runToolForResume: refuseToolCall first (T5)",
		},
		{
			marker:
				/if \(!dispatch \|\| \(await this\.refuseToolCall\(dispatch\.tool, dispatch\.args\)\)\) return;\s*try \{\s*const result = await this\.executor\.execute\(dispatch\.tool, dispatch\.args\)/,
			gate: "pre-fetch (tryRunPreToolRouter): refuseToolCall first (T9)",
		},
		{
			marker:
				/runGatedCommand\(\s*command: string,\s*timeoutSec: number,\s*env\?: Record<string, string \| undefined>,?\s*\): Promise<string> \{\s*return this\.executor\.runCommand\(command, timeoutSec, env\);/,
			gate: "KNOWN UNGATED (issue 90): runGatedCommand, the headless done gate's build and test run, reached only under --yes. Executor policy only: no mode check, hooks or audit row. A second ungated site fails here.",
		},
	];
	/** Executor members that run nothing. Anything else on this.executor must be a registered run site. */
	const NON_RUNNING = new Set([
		"getWorkingDirectory",
		"retiredTurnEndNudge",
		"markLayoutSent",
		"beginTurn",
		"takePresendStop",
		"getToolDefinitions",
		"setItemGate",
		"setItemEnd",
		"setExtensionRunner",
		"setPlugHooks",
		"createdFiles",
	]);
	const RUNS = new Set(["execute", "runCommand"]);

	/** Every this.executor reference in agent.ts: runs, and anything that is neither a run nor a known non-run. */
	function classifyExecutorUses(src: string): { runs: number; unknown: string[] } {
		let runs = 0;
		const unknown: string[] = [];
		// Any receiver (`this`, `self`, a cast), and any "executor" string (bracket access, Reflect.get).
		const ref = /(?:\?\.|\.)\s*executor\b|\[\s*["'`]executor["'`]\s*\]/g;
		for (let m = ref.exec(src); m; m = ref.exec(src)) {
			const after = src.slice(m.index + m[0].length, m.index + m[0].length + 80);
			const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index)).trim();
			if (/^\s*=\s*new ToolExecutor\(/.test(after)) continue; // the constructor's own assignment
			const member = after.match(/^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/)?.[1];
			if (member && NON_RUNNING.has(member)) continue;
			if (member && RUNS.has(member)) {
				runs++;
				continue;
			}
			// An alias, a cast, a bracket access, a .bind or a private member: never a silent pass.
			unknown.push(line);
		}
		// An "executor" string anywhere else (Reflect.get(this, "executor"), a computed key) is a dodge.
		const literals = src.match(/["'`]executor["'`]/g)?.length ?? 0;
		const bracketed = src.match(/\[\s*["'`]executor["'`]\s*\]/g)?.length ?? 0;
		if (literals > bracketed) unknown.push(`${literals - bracketed} "executor" string literal(s)`);
		// Destructuring the executor off this is an alias too.
		for (const d of src.match(/\{[^}]*\bexecutor\b[^}]*\}\s*=\s*this\b/g) ?? []) unknown.push(d);
		return { runs, unknown };
	}

	test("T7 registry: every this.executor use in agent.ts is a known non-run or a registered run site", () => {
		const src = code("packages/eight/agent.ts");
		const uses = classifyExecutorUses(src);
		expect(uses.unknown).toEqual([]);
		expect(uses.runs).toBe(RUN_SITES.length);
		for (const s of RUN_SITES)
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

	test("T9 pre-fetch: every router strategy's tool reaches the gate, and a refusal runs nothing", async () => {
		const agent = localAgent();
		const i = instrument(agent);
		const routed = agent as unknown as {
			preToolRouter: { classify: () => unknown };
			tryRunPreToolRouter: (m: string) => Promise<void>;
		};
		const want: Record<string, string> = {
			ast: "search_symbols",
			grep: "run_command",
			glob: "list_files",
			vector: "recall",
			fileread: "read_file",
		};
		for (const strategy of Object.keys(want)) {
			routed.preToolRouter.classify = () => ({
				strategy,
				args: { symbol: "x", pattern: "x", query: "x", path: "a.txt" },
				confidence: 0.9,
				reason: "gates-coverage",
			});
			await routed.tryRunPreToolRouter("find x");
		}
		expect(Object.values(want).filter((t) => !i.gated.includes(t))).toEqual([]);
		expect(i.executed).toEqual([]);
		expect(i.started).toEqual([]);
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
			"`8gent mcp-server` tools/call: executor policy only, no mode, hooks or audit (issue 89 todo below)",
		"packages/eight/scripts/desktop-act-dry.ts": "dev script, not shipped",
		"packages/decide/eval/locate-run.ts": "eval harness, not shipped",
		"packages/ast-index/eval/real-queries.ts": "eval harness, not shipped",
	};

	/** Builds a ToolExecutor under its own name or an alias (`as X`, `{ ToolExecutor: X }`, `X = ToolExecutor`). */
	function buildsExecutor(src: string): boolean {
		const names = new Set(["ToolExecutor"]);
		for (const re of [
			/\bToolExecutor\s+as\s+([A-Za-z_$][\w$]*)/g,
			/\bToolExecutor\s*:\s*([A-Za-z_$][\w$]*)/g,
			/\b([A-Za-z_$][\w$]*)\s*=\s*ToolExecutor\b/g,
		])
			for (const m of src.matchAll(re)) names.add(m[1]);
		return [...names].some((n) =>
			new RegExp(`new\\s+(?:[\\w$]+\\.)?${n.replace(/\$/g, "\\$")}\\s*\\(`).test(src),
		);
	}

	test("T8 registry: every ToolExecutor owner outside tests is registered", () => {
		const owners: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir)) {
				if (e === "node_modules" || e.startsWith(".")) continue;
				const p = join(dir, e);
				if (statSync(p).isDirectory()) {
					if (["__tests__", "fixtures", "tests"].includes(e)) continue;
					walk(p);
				} else if (/\.(tsx?|mts|cts|jsx?|mjs)$/.test(e) && !/\.(test|spec)\.\w+$/.test(e)) {
					if (buildsExecutor(code(relative(REPO_ROOT, p)))) owners.push(relative(REPO_ROOT, p));
				}
			}
		};
		// The whole repo, so a script or app outside packages, apps and bin is seen too.
		walk(REPO_ROOT);
		expect(owners.sort()).toEqual(Object.keys(EXECUTOR_OWNERS).sort());
	});

	test.todo(
		"the batch tool's inner calls each take refuseToolCall and noteToolStart (fixed by PR 76, batch-read.test.ts)",
		notOnMain,
	);

	test.todo(
		"`8gent mcp-server` tools/call takes the mode check, PreToolUse hooks and the session audit row (issue 89, packages/mcp/server.ts, no fix PR yet)",
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
