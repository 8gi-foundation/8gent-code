/**
 * #73 role routing, 8SO hold on #80: the small role (compaction, summaries)
 * gets the conversation, so it is held to the main call's gates. A local-only
 * policy, or a turn held local by a sensitive read (.env), never sends history
 * to a hosted small role, even one with a key.
 *
 * Drives the shipping /compact path (Agent.compactNow) against a fake local
 * session endpoint; globalThis.fetch routes openrouter.ai to a second fake so
 * the test counts what the hosted small role would have received. Any other
 * non-local host is refused. $HOME is faked: settings.json there carries the
 * roles and the routing policy.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	OPENROUTER_API_KEY: "sk-or-roles-80",
	// Hosted is opt-in (#3710). Granted, so the policy and the privacy gate alone must stop it.
	EIGHT_ALLOW_HOSTED: "1",
};
let home: string;
let repo: string;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const seen: Array<"session" | "openrouter"> = [];
let sessionPort = 0;
let fetchSpy: { mockRestore: () => void } | undefined;
let homeSpy: { mockRestore: () => void } | undefined;

function fake(name: "session" | "openrouter"): ReturnType<typeof Bun.serve> {
	const s = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			seen.push(name);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{ index: 0, message: { role: "assistant", content: "Summary." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	servers.push(s);
	return s;
}

function writeSettings(policy: string): void {
	writeFileSync(
		join(home, ".8gent", "settings.json"),
		JSON.stringify({
			performance: { mode: "balanced", introBanner: "off" },
			voice: { silenceThresholdMs: 1500 },
			routing: { policy },
			models: { roles: { small: { provider: "openrouter", model: "tiny:free" } } },
		}),
	);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "roles80-home-"));
	repo = mkdtempSync(join(tmpdir(), "roles80-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	sessionPort = fake("session").port ?? 0;
	const openrouter = fake("openrouter");
	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "openrouter.ai") {
			const path = url.pathname.replace(/^\/api/, "");
			return realFetch(`http://127.0.0.1:${openrouter.port}${path}${url.search}`, init);
		}
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
			return Promise.reject(new Error(`test blocks network to ${url.hostname}`));
		}
		return realFetch(input, init);
	}) as typeof fetch);
	// Bun's os.homedir() ignores a runtime $HOME; agent.ts reads settings.json through it.
	homeSpy = spyOn(os, "homedir").mockReturnValue(home);
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(() => {
	fetchSpy?.mockRestore();
	homeSpy?.mockRestore();
	for (const s of servers) s.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

/** A local session with enough history that /compact has an older middle to summarise. */
function build(recentFilePaths: string[] = []): AgentT {
	const agent = new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${sessionPort}`,
	} as ConstructorParameters<typeof Agent>[0]);
	const history = [{ role: "system", content: "You are a test agent." }];
	for (let i = 0; i < 12; i++) {
		history.push({ role: "user", content: `Step ${i}: describe the api release plan.` });
		history.push({ role: "assistant", content: `Step ${i}: the api ships after the schema check.` });
	}
	const a = agent as unknown as { messageHistory: unknown; recentFilePaths: string[] };
	a.messageHistory = history;
	a.recentFilePaths = recentFilePaths;
	return agent;
}

/**
 * Who received the summary calls for one /compact. readPolicyState never reads
 * settings.json under `bun test` (NODE_ENV=test), so the policy is read for real
 * only inside this window.
 */
async function compact(agent: AgentT): Promise<Array<"session" | "openrouter">> {
	const start = seen.length;
	const env = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	try {
		const r = await agent.compactNow();
		expect(r?.messagesRemoved ?? 0).toBeGreaterThan(0);
	} finally {
		process.env.NODE_ENV = env;
	}
	return seen.slice(start);
}

describe("the small role is held to the main call's gates (#80)", () => {
	test("control: local-first, keyed hosted small role, nothing sensitive read: it gets the summary", async () => {
		writeSettings("local-first");
		const got = await compact(build());
		expect(got).toContain("openrouter");
		expect(got).not.toContain("session");
	}, 30000);

	test("local-only policy: a keyed hosted small role receives nothing; the session summarises", async () => {
		writeSettings("local-only");
		const got = await compact(build());
		expect(got.filter((s) => s === "openrouter")).toEqual([]);
		expect(got).toContain("session");
	}, 30000);

	test("turn held local by a .env read: a keyed hosted small role receives nothing", async () => {
		writeSettings("local-first");
		const got = await compact(build([join(repo, ".env")]));
		expect(got.filter((s) => s === "openrouter")).toEqual([]);
		expect(got).toContain("session");
	}, 30000);
});
