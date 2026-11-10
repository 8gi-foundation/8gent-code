/**
 * #180: /term hands the model the session it opened, and every turn after
 * carries the list of sessions this app opened. Real tmux sessions on this app's
 * private tmux server (openOwnedSession, the same call /term makes), the real
 * Agent.chat() against a fake OpenAI-compatible endpoint, and the real term_*
 * tools. Skipped when tmux is not installed. $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { Agent as AgentT } from "./agent";

const tmux = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
const itTmux = tmux ? test : test.skip;

let Agent: typeof import("./agent").Agent;
let tools: typeof import("./term-tools");
let list: typeof import("./term-session-list");
const HEADING = "Terminal sessions this app opened";
const ID = /8gent-term-[0-9a-f]{12}/;

type Body = { messages: Array<{ role: string; content: unknown }> };
type Reply = (body: Body) => string;

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
	EIGHT_HEADLESS: "1",
	EIGHT_HEADLESS_APPROVE: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let reply: Reply = () => "DONE.";

const toolCall = (name: string, args: Record<string, unknown>) =>
	["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "term180-home-"));
	repo = mkdtempSync(join(tmpdir(), "term180-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	tools = await import("./term-tools");
	list = await import("./term-session-list");
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as Body;
			bodies.push(body);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: reply(body) },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	bodies = [];
	reply = () => "DONE.";
	tools?.endOwnedSessions();
});

afterAll(() => {
	tools?.endOwnedSessions();
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	rmRetry(home);
	rmRetry(repo);
});

function build(): AgentT {
	const agent = new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
	(agent as unknown as { modelSees: () => Promise<boolean> }).modelSees = () =>
		Promise.resolve(true);
	return agent;
}

/** What /term does to open a session, minus the Terminal.app window. */
const open = (label: string, command: string) => tools.openOwnedSession({ command, label });

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 60));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const logHas = (path: string, text: string) => () => (list.lastLineOf(path) ?? "").includes(text);
// The program waits a second before it prints: tmux attaches its log a moment after the session starts.

/** Everything the model was sent on the last request of the turn. */
const sent = () => JSON.stringify(bodies[bodies.length - 1]?.messages ?? []);
const lastUser = (b: Body) => {
	const u = b.messages.filter((m) => m.role === "user").at(-1)?.content;
	return typeof u === "string" ? u : JSON.stringify(u);
};
const idIn = (b: Body) => JSON.stringify(b.messages).match(ID)?.[0] ?? "";

describe("the model sees the sessions this app opened (#180)", () => {
	itTmux(
		"next turn carries the session's real name, id, pid, state and last line",
		async () => {
			const s = await open("Sparring", "sleep 1; echo READY_180; cat");
			await until(logHas(s.logPath, "READY_180"), "first output");
			await build().chat("can you see the claude session in the sparring tab");
			const text = sent();
			expect(text).toContain(HEADING);
			expect(text).toContain("Sparring");
			expect(text).toContain(s.target);
			expect(text).toContain(`pid ${s.pid}`);
			expect(text).toContain("| running |");
			expect(text).toContain("last line: READY_180");
		},
		60_000,
	);

	itTmux(
		"an exited session shows as exited",
		async () => {
			const s = await open("Short", "sleep 1; echo bye_180; sleep 1");
			const { hasTmuxSession } = await import("../terminal-tab/index.js");
			await until(async () => !(await hasTmuxSession(s.target)), "exit");
			await build().chat("is it still going");
			expect(sent()).toContain("| exited |");
			expect(sent()).toContain("bye_180");
		},
		60_000,
	);

	itTmux(
		"with no sessions the list is absent, not an empty heading",
		async () => {
			expect(await list.termSessionBlock()).toBe("");
			await build().chat("what terminal sessions are open right now");
			expect(bodies.length).toBeGreaterThan(0);
			expect(sent()).not.toContain(HEADING);
			expect(sent()).not.toContain("No terminal sessions");
		},
		60_000,
	);

	itTmux(
		"only the registry is listed: a session id never opened here is not",
		async () => {
			const s = await open("Mine", "cat");
			await build().chat("what sessions are open");
			const ids = [...new Set(sent().match(new RegExp(ID, "g")) ?? [])];
			expect(ids).toEqual([s.target]);
			expect(tools.ownedSessions().map((o) => o.target)).toEqual([s.target]);
		},
		60_000,
	);

	itTmux(
		"an unchanged list is not repeated; a change is sent once",
		async () => {
			const s = await open("Sparring", "cat");
			const agent = build();
			await agent.chat("first");
			await agent.chat("second");
			const count = (x: string) => x.split(HEADING).length - 1;
			expect(count(sent())).toBe(1);
			await tools.executeTermTool("term_kill", { sessionId: s.target });
			await agent.chat("third");
			expect(sent()).toContain("No terminal sessions opened by this app are open now.");
		},
		90_000,
	);
});

describe("/term tells the model, and the model can drive the session (#180)", () => {
	itTmux(
		"the notice and the line are built from the session's real state",
		async () => {
			const s = await open("Sparring", "sleep 1; echo READY_180; cat");
			const line = await list.openedLine(s);
			const notice = await list.sessionOpenedNotice(s);
			for (const text of [line, notice]) {
				expect(text).toContain("Sparring");
				expect(text).toContain(s.target);
				expect(text).toContain(`pid ${s.pid}`);
				expect(text).toContain("running");
			}
			expect(line).not.toContain("?");
			expect(notice).toContain("started: sleep 1; echo READY_180; cat");
		},
		60_000,
	);

	itTmux(
		"no typing: the notice alone gives a turn that reads the session's real output",
		async () => {
			const s = await open("Sparring", "sleep 1; echo READY_180; cat");
			await until(logHas(s.logPath, "READY_180"), "first output");
			reply = (b) =>
				JSON.stringify(b.messages).includes("newLines")
					? "I have the Sparring session and it shows READY_180."
					: toolCall("term_read", { sessionId: idIn(b) });
			await build().chat(await list.sessionOpenedNotice(s));
			expect(lastUser(bodies[0])).toContain(s.target);
			// The second request carries term_read's real result.
			expect(JSON.stringify(bodies[1].messages)).toContain("READY_180");
			expect(JSON.stringify(bodies[1].messages)).toContain("newLines");
		},
		60_000,
	);

	itTmux(
		"then one plain instruction sends text to the session and it comes back",
		async () => {
			const s = await open("Sparring", "cat");
			reply = (b) =>
				JSON.stringify(b.messages).includes("enter")
					? "Sent it."
					: toolCall("term_send", { sessionId: idIn(b), text: "hello180" });
			await build().chat("tell it hello180");
			// The id came from the per-turn list, not from the person.
			expect(JSON.stringify(bodies[0].messages)).toContain(s.target);
			await until(logHas(s.logPath, "hello180"), "echo from the session");
			expect(list.lastLineOf(s.logPath)).toContain("hello180");
		},
		60_000,
	);

	itTmux(
		"two opens back to back give two notices, one each, in order; a failed open says so",
		async () => {
			const told: string[] = [];
			const said: string[] = [];
			const tabs: string[] = [];
			const hooks = {
				addTab: (x: { target: string }) => tabs.push(x.target),
				say: (l: string) => said.push(l),
				tellModel: (n: string) => told.push(n),
			};
			await Promise.all([
				list.openAndAnnounce(() => open("One", "cat"), "One", hooks),
				list.openAndAnnounce(() => open("Two", "cat"), "Two", hooks),
			]);
			expect(told.length).toBe(2);
			expect(tabs.length).toBe(2);
			expect(tabs[0]).not.toBe(tabs[1]);
			for (const t of tabs) expect(told.filter((n) => n.includes(t)).length).toBe(1);
			expect(said.filter((l) => l.startsWith("Opened")).length).toBe(2);

			await list.openAndAnnounce(() => Promise.reject(new Error("tmux said no")), "Broken", hooks);
			expect(told.length).toBe(3);
			expect(told[2]).toContain("failed to start: tmux said no");
			expect(said.at(-1)).toContain("Failed to open Broken");
			expect(tabs.length).toBe(2);
		},
		60_000,
	);
});

describe("caps and output lines (#180)", () => {
	itTmux(
		"at most MAX_LISTED sessions are listed, the rest counted",
		async () => {
			for (let i = 0; i < list.MAX_LISTED + 1; i++) await open(`S${i}`, "cat");
			const block = await list.termSessionBlock();
			expect(block.split("\n").filter((l) => l.startsWith("- ")).length).toBe(list.MAX_LISTED);
			expect(block).toContain("(1 older not shown)");
		},
		90_000,
	);

	itTmux(
		"a long name and a long command are cut",
		async () => {
			await open("N".repeat(200), `echo ${"c".repeat(400)}; cat`);
			const row = (await list.termSessionBlock()).split("\n").find((l) => l.startsWith("- ")) ?? "";
			const started = row.split("started: ")[1]?.split(" | ")[0] ?? "";
			expect(row).not.toContain("N".repeat(60));
			expect(started.length).toBeLessThanOrEqual(list.MAX_STARTED);
		},
		60_000,
	);

	test("the last line has control sequences removed, a secret scrubbed, and is cut", () => {
		const log = join(repo, "s.log");
		const key = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
		writeFileSync(log, `old line\n\x1b[32mtoken=${key}\x1b[0m\x07 ${"x".repeat(500)}\n`);
		const last = list.lastLineOf(log) ?? "";
		expect(last).not.toContain(key);
		expect(last).not.toContain("\x1b");
		expect(last).not.toContain("\x07");
		expect(last.length).toBeLessThanOrEqual(list.MAX_LAST_LINE);
		expect(list.lastLineOf(join(repo, "missing.log"))).toBeNull();
	});
});
