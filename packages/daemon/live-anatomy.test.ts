import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "./events";
import {
	type LiveEvent,
	_resetLiveLogForTest,
	admit,
	buildLiveGraph,
	handleLiveHttp,
	installLiveAnatomy,
	liveClose,
	liveMessage,
	liveOpen,
	sessionToMermaid,
} from "./live-anatomy";

const S = "sess0001aaaa";
const start = (tool: string, input: Record<string, unknown>, toolCallId?: string): LiveEvent => ({
	event: "tool:start",
	payload: { sessionId: S, tool, input, ...(toolCallId ? { toolCallId } : {}) },
});
const result = (tool: string, extra: Record<string, unknown> = {}): LiveEvent => ({
	event: "tool:result",
	payload: { sessionId: S, tool, output: "ok", durationMs: 5, ...extra },
});
const begin: LiveEvent = { event: "session:start", payload: { sessionId: S, channel: "api" } };

const stateOf = (events: LiveEvent[], label: string) =>
	buildLiveGraph(events).nodes.find((n) => n.label === label)?.state;

describe("sessionToMermaid (#4190)", () => {
	test("empty input draws an idle graph, not an error", () => {
		const text = sessionToMermaid([]);
		expect(text.startsWith("flowchart LR\n")).toBe(true);
		expect(text).toContain('idle(["no session events yet"])');
		expect(buildLiveGraph([]).nodes).toEqual([]);
	});

	test("running: a started call with no result is green", () => {
		const events = [begin, start("write_file", { path: "src/app.ts", content: "a\nb" }, "t1")];
		const g = buildLiveGraph(events);
		expect(stateOf(events, "src/app.ts")).toBe("running");
		expect(stateOf(events, `session ${S.slice(0, 8)} - api`)).toBe("running");
		expect(g.mermaid).toContain('subgraph d1["src"]');
		expect(g.mermaid).toContain('f1["src/app.ts"]');
		expect(g.mermaid).toContain('s1 -->|"write_file"| f1');
		expect(g.mermaid).toMatch(/class (s1,f1|f1,s1) running/);
		expect(g.nodes.find((n) => n.id === "f1")?.diff).toBe("+ a\n+ b");
	});

	test("paused: an approval waiting holds the command amber, and so its session", () => {
		const events = [
			begin,
			start("run_command", { command: "rm -rf build" }, "t1"),
			{
				event: "approval:required",
				payload: {
					sessionId: S,
					tool: "run_command",
					input: { command: "rm -rf build" },
					requestId: "r1",
				},
			},
		];
		expect(stateOf(events, "$ rm -rf build")).toBe("paused");
		expect(buildLiveGraph(events).nodes[0]?.state).toBe("paused");
		expect(sessionToMermaid(events)).toContain("class s1,c1 paused");
		// The request id never reaches the page.
		expect(JSON.stringify(buildLiveGraph(events))).not.toContain("r1");
	});

	test("failed: success false, an error string, or an expired approval is red", () => {
		const a = [
			begin,
			start("run_command", { command: "bun test" }, "t1"),
			result("run_command", { toolCallId: "t1", success: false, output: "1 fail" }),
		];
		expect(stateOf(a, "$ bun test")).toBe("failed");
		expect(buildLiveGraph(a).nodes.find((n) => n.kind === "command")?.output).toBe("1 fail");
		const b = [
			begin,
			start("read_file", { path: "x.ts" }),
			result("read_file", { output: "Error: ENOENT" }),
		];
		expect(stateOf(b, "x.ts")).toBe("failed");
		// The executor reports a non-zero exit as text with success true (seen live, #4190).
		const d = [
			begin,
			start("run_command", { command: "ls missing" }, "t1"),
			result("run_command", {
				toolCallId: "t1",
				success: true,
				output: "Exit code 1:\n\nls: missing: No such file",
			}),
		];
		expect(stateOf(d, "$ ls missing")).toBe("failed");
		const e = [
			begin,
			start("edit_file", { path: "gone.ts", oldText: "a", newText: "b" }, "t1"),
			result("edit_file", {
				toolCallId: "t1",
				success: true,
				output: "File not found: /w/gone.ts",
			}),
		];
		expect(stateOf(e, "gone.ts")).toBe("failed");
		const c = [
			begin,
			{
				event: "approval:required",
				payload: { sessionId: S, tool: "run_command", input: { command: "make" }, requestId: "r9" },
			},
			{ event: "approval:closed", payload: { sessionId: S, requestId: "r9", outcome: "expired" } },
		];
		expect(stateOf(c, "$ make")).toBe("failed");
		expect(sessionToMermaid(c)).toContain("class c1 failed");
	});

	test("done: a finished call is grey, an idle session is never green", () => {
		const events = [
			begin,
			start("edit_file", { path: "a.ts", oldText: "x", newText: "y" }, "t1"),
			result("edit_file", { toolCallId: "t1", success: true }),
		];
		expect(stateOf(events, "a.ts")).toBe("done");
		expect(buildLiveGraph(events).nodes[0]?.state).toBe("done");
		expect(buildLiveGraph(events).nodes.find((n) => n.label === "a.ts")?.diff).toBe("- x\n+ y");
	});

	test("deterministic: same events give the same text; repeats count on one edge", () => {
		const events = [
			begin,
			start("edit_file", { path: "lib/a.ts", oldText: "1", newText: "2" }, "t1"),
			result("edit_file", { toolCallId: "t1", success: true }),
			start("edit_file", { path: "lib/a.ts", oldText: "2", newText: "3" }, "t2"),
			result("edit_file", { toolCallId: "t2", success: true }),
			start("web_search", { query: "x" }, "t3"),
		];
		const one = sessionToMermaid(events);
		expect(sessionToMermaid(structuredClone(events))).toBe(one);
		expect(one).toContain('s1 -->|"edit_file x2"| f1');
		expect(one).toContain('t1{{"web_search"}}');
	});

	test("labels cannot break out of Mermaid quoting", () => {
		const text = sessionToMermaid([begin, start("run_command", { command: 'echo "a" <b> #c' })]);
		expect(text).toContain('c1[/"$ echo #quot;a#quot; #lt;b#gt; #35;c"/]');
	});

	test("results without call ids pair with the oldest open call of that tool", () => {
		const events = [
			begin,
			start("run_command", { command: "one" }),
			start("run_command", { command: "two" }),
			result("run_command", { success: true }),
		];
		expect(stateOf(events, "$ one")).toBe("done");
		expect(stateOf(events, "$ two")).toBe("running");
	});
});

describe("live feed", () => {
	const bus = new EventBus();
	beforeEach(() => _resetLiveLogForTest());
	afterAll(() => _resetLiveLogForTest());

	test("a watcher gets the graph from bus events, and a token is checked", () => {
		installLiveAnatomy(bus, "secret-token");
		const sent: string[] = [];
		const ws = { send: (d: string) => sent.push(d) };
		liveOpen(ws);
		liveMessage(ws, JSON.stringify({ type: "live:watch", token: "wrong" }));
		expect(JSON.parse(sent.pop() as string)).toEqual({
			type: "live:error",
			message: "unauthorized",
		});
		bus.emit("session:start", { sessionId: S, channel: "api" });
		expect(sent).toHaveLength(0);
		liveMessage(ws, JSON.stringify({ type: "live:watch", token: "secret-token" }));
		bus.emit("tool:start", {
			sessionId: S,
			tool: "write_file",
			input: { path: "a.ts", content: "x" },
		});
		const last = JSON.parse(sent.at(-1) as string);
		expect(last.type).toBe("live:graph");
		expect(last.mermaid).toContain('f1["a.ts"]');
		liveClose(ws);
		const n = sent.length;
		bus.emit("session:end", { sessionId: S, reason: "done" });
		expect(sent).toHaveLength(n);
	});

	test("8SO 5844: private channels never reach the page, and payloads are scrubbed", () => {
		installLiveAnatomy(bus, null);
		const sent: string[] = [];
		const ws = { send: (d: string) => sent.push(d) };
		liveOpen(ws);
		liveMessage(ws, JSON.stringify({ type: "live:watch" }));
		for (const channel of ["telegram", "table", "computer", "delegation", "classroom"]) {
			bus.emit("session:start", { sessionId: `p-${channel}`, channel });
			bus.emit("tool:start", {
				sessionId: `p-${channel}`,
				tool: "read_file",
				input: { path: `${channel}.md` },
			});
		}
		// A session whose start was never seen is kept out too (fail closed).
		bus.emit("tool:start", {
			sessionId: "unseen",
			tool: "read_file",
			input: { path: "unseen.md" },
		});
		expect(sent).toHaveLength(1);
		const bearer = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
		const envKey = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
		bus.emit("session:start", { sessionId: "pub", channel: "tui" });
		bus.emit("tool:start", {
			sessionId: "pub",
			tool: "write_file",
			input: { path: ".env", content: envKey },
		});
		bus.emit("tool:start", {
			sessionId: "pub",
			tool: "run_command",
			input: { command: `curl -H "Authorization: ${bearer}" http://x` },
		});
		bus.emit("tool:result", {
			sessionId: "pub",
			tool: "run_command",
			output: envKey,
			durationMs: 1,
			success: true,
		});
		const last = sent.at(-1) as string;
		expect(last).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		expect(last).toContain("REDACTED");
		expect(last).toContain(".env");
		for (const channel of ["telegram", "table", "computer", "delegation", "classroom", "unseen"]) {
			expect(last).not.toContain(`${channel}.md`);
		}
		expect(admit("tool:start", { sessionId: "p-telegram", tool: "x", input: {} })).toBeNull();
	});

	test("8SO 5844: /live and its script answer loopback peers only", () => {
		for (const path of ["/live", "/live/mermaid.js"]) {
			const r = handleLiveHttp(
				new Request(`http://10.0.0.5${path}`),
				new URL(`http://10.0.0.5${path}`),
				false,
			);
			expect(r?.status).toBe(403);
		}
	});

	test("GET /live serves the page; other paths fall through", () => {
		const page = handleLiveHttp(
			new Request("http://127.0.0.1/live"),
			new URL("http://127.0.0.1/live"),
			true,
		);
		expect(page?.headers.get("content-type")).toContain("text/html");
		expect(
			handleLiveHttp(new Request("http://127.0.0.1/x"), new URL("http://127.0.0.1/x"), true),
		).toBeNull();
		const post = new Request("http://127.0.0.1/live", { method: "POST" });
		expect(handleLiveHttp(post, new URL(post.url), true)).toBeNull();
	});

	test("the page loads Mermaid from the daemon, never a CDN", async () => {
		const page = await (
			handleLiveHttp(
				new Request("http://127.0.0.1/live"),
				new URL("http://127.0.0.1/live"),
				true,
			) as Response
		).text();
		expect(page).toContain('<script src="/live/mermaid.js"></script>');
		expect(page).not.toMatch(/https?:\/\/(cdn|unpkg)/);
		const js = handleLiveHttp(
			new Request("http://127.0.0.1/live/mermaid.js"),
			new URL("http://127.0.0.1/live/mermaid.js"),
			true,
		) as Response;
		expect(js.status).toBe(200);
	});
});

describe("live route on the real gateway", () => {
	test("GET /live, then /live/ws streams the graph a real bus event builds", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { bus } = await import("./events");
		const { startGateway } = await import("./gateway");
		const dataDir = mkdtempSync(join(tmpdir(), "live-anatomy-"));
		const saved = { data: process.env.EIGHT_DATA_DIR, host: process.env.DAEMON_HOSTNAME };
		process.env.EIGHT_DATA_DIR = dataDir;
		process.env.DAEMON_HOSTNAME = "127.0.0.1";
		const pool = { size: 0, hasSession: () => false, getStatus: () => ({}) };
		// biome-ignore lint/suspicious/noExplicitAny: a stand-in pool; /live never touches it
		const server = startGateway({ port: 0, authToken: null, pool: pool as any });
		try {
			const page = await fetch(`http://127.0.0.1:${server.port}/live`);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("8gent live anatomy");
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/live/ws`);
			const frames: Array<{ type: string; mermaid?: string }> = [];
			ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
			await new Promise<void>((r) => (ws.onopen = () => r()));
			ws.send(JSON.stringify({ type: "live:watch", session: "gw-sess-1" }));
			await Bun.sleep(50);
			bus.emit("session:start", { sessionId: "gw-sess-1", channel: "api" });
			bus.emit("tool:start", {
				sessionId: "gw-sess-1",
				tool: "run_command",
				input: { command: "bun test" },
			});
			await Bun.sleep(50);
			expect(frames.at(-1)?.mermaid).toContain('c1[/"$ bun test"/]');
			expect(frames.at(-1)?.mermaid).toContain("running");
			ws.close();
		} finally {
			server.stop(true);
			for (const [k, v] of [
				["EIGHT_DATA_DIR", saved.data],
				["DAEMON_HOSTNAME", saved.host],
			] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
