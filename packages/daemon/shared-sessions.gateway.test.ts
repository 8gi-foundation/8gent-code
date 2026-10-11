/**
 * #3929: two real WebSocket clients on one real gateway share a session.
 * The pool is a stand-in whose turn echoes the prompt; everything between the
 * sockets and the pool (routing, echo, fan-out, persistence, disconnect) is
 * the real gateway.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "./agent-pool";
import { bus } from "./events";
import { startGateway } from "./gateway";

class EchoAgent {
	history: Array<{ role: string; content: string }> = [{ role: "system", content: "sys" }];
	aborted = 0;
	getMessageHistory() {
		return [...this.history];
	}
	restoreFromCheckpoint(messages: Array<{ role: string; content: string }>) {
		this.history = [this.history[0], ...messages];
	}
	abort() {
		this.aborted++;
	}
	getModel() {
		return "eight:latest";
	}
	getRuntime() {
		return "ollama";
	}
	getWorkingDirectory() {
		return "/work";
	}
}

class EchoPool {
	live = new Map<string, { channel: string; agent: EchoAgent; busy: boolean }>();
	get size() {
		return this.live.size;
	}
	createSession(id: string, channel: string) {
		this.live.set(id, { channel, agent: new EchoAgent(), busy: false });
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.live.delete(id);
	}
	getAgent(id: string) {
		return this.live.get(id)?.agent ?? null;
	}
	getSessionInfo(id: string) {
		const e = this.live.get(id);
		if (!e) return null;
		return { channel: e.channel, messageCount: 0, busy: e.busy, createdAt: 1, lastActiveAt: 2 };
	}
	getActiveSessions() {
		return [...this.live].map(([sessionId, e]) => ({
			sessionId,
			channel: e.channel,
			messageCount: 0,
			createdAt: 1,
		}));
	}
	getStatus() {
		return {};
	}
	abort() {
		return false;
	}
	async chat(sessionId: string, text: string): Promise<string> {
		const e = this.live.get(sessionId)!;
		const reply = `echo: ${text}`;
		e.agent.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
		bus.emit("agent:stream", { sessionId, chunk: reply, final: true });
		return reply;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: protocol frames read in assertions.
type Frame = Record<string, any>;

class Client {
	frames: Frame[] = [];
	private ws: WebSocket;
	ready: Promise<void>;
	constructor(port: number) {
		this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
		this.ws.onmessage = (ev) => this.frames.push(JSON.parse(String(ev.data)));
		this.ready = new Promise((r) => {
			this.ws.onopen = () => r();
		});
	}
	send(f: Frame) {
		this.ws.send(JSON.stringify(f));
	}
	async next(pred: (f: Frame) => boolean, ms = 2000): Promise<Frame> {
		const start = Date.now();
		while (Date.now() - start < ms) {
			const f = this.frames.find(pred);
			if (f) return f;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`no matching frame; got ${JSON.stringify(this.frames)}`);
	}
	events(name: string) {
		return this.frames.filter((f) => f.type === "event" && f.event === name);
	}
	close() {
		this.ws.close();
	}
}

const settle = () => new Promise((r) => setTimeout(r, 100));

const pool = new EchoPool();
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const savedData = process.env.EIGHT_DATA_DIR;
const savedHost = process.env.DAEMON_HOSTNAME;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "shared-gw-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	server = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
});

afterAll(() => {
	server.stop(true);
	if (savedData === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = savedData;
	if (savedHost === undefined) delete process.env.DAEMON_HOSTNAME;
	else process.env.DAEMON_HOSTNAME = savedHost;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("shared sessions over the gateway", () => {
	it("two clients see one live session, and either can send", async () => {
		pool.createSession("s_shared", "tui");
		const ends: string[] = [];
		const off = bus.on("session:end", (p) => {
			if (p.sessionId === "s_shared") ends.push(p.reason);
		});
		const tui = new Client(server.port as number);
		const panel = new Client(server.port as number);
		await Promise.all([tui.ready, panel.ready]);

		panel.send({ type: "session:list" });
		const list = await panel.next((f) => f.type === "session:list");
		expect(list.live.map((l: Frame) => l.sessionId)).toContain("s_shared");

		tui.send({ type: "session:attach", sessionId: "s_shared", channel: "tui" });
		await tui.next((f) => f.type === "session:attached");
		panel.send({ type: "session:attach", sessionId: "s_shared", channel: "browser" });
		const attached = await panel.next((f) => f.type === "session:attached");
		expect(attached).toMatchObject({ channel: "tui", restored: false, transcript: [] });

		tui.send({ type: "prompt", text: "hello from the TUI" });
		const echoed = await panel.next((f) => f.type === "event" && f.event === "user:message");
		expect(echoed.payload).toEqual({
			sessionId: "s_shared",
			text: "hello from the TUI",
			channel: "tui",
		});
		await panel.next((f) => f.event === "agent:stream" && f.payload.final);
		await tui.next((f) => f.event === "agent:stream" && f.payload.final);
		// The sender is not echoed its own words.
		expect(tui.events("user:message")).toEqual([]);

		panel.send({ type: "prompt", text: "and from the panel" });
		const back = await tui.next(
			(f) => f.event === "user:message" && f.payload.text === "and from the panel",
		);
		expect(back.payload).toMatchObject({ sessionId: "s_shared", channel: "browser" });

		// The turn was saved to the store the TUI reads.
		await settle();
		const file = join(dataDir, "sessions", "s_shared.json");
		expect(existsSync(file)).toBe(true);
		const saved = JSON.parse(readFileSync(file, "utf8"));
		expect(saved.channel).toBe("tui");
		expect(saved.messages.map((m: Frame) => m.content)).toEqual([
			"hello from the TUI",
			"echo: hello from the TUI",
			"and from the panel",
			"echo: and from the panel",
		]);

		// One client leaving does not end the session for the other.
		tui.close();
		await settle();
		expect(ends.filter((r) => r === "client-disconnect")).toEqual([]);
		expect(
			panel.events("session:end").filter((f) => f.payload.reason === "client-disconnect"),
		).toEqual([]);
		// The last one leaving still does.
		panel.close();
		await settle();
		expect(ends).toContain("client-disconnect");
		bus.off(off);
	});

	it("a past session is resumed into the daemon with its history", async () => {
		pool.live.clear();
		const c = new Client(server.port as number);
		await c.ready;
		c.send({ type: "session:list" });
		const list = await c.next((f) => f.type === "session:list");
		expect(list.past.map((p: Frame) => p.sessionId)).toContain("s_shared");

		c.send({ type: "session:attach", sessionId: "s_shared" });
		const a = await c.next((f) => f.type === "session:attached");
		expect(a.restored).toBe(true);
		expect(a.transcript.length).toBe(4);
		expect(pool.getAgent("s_shared")!.getMessageHistory().length).toBe(5);

		c.send({ type: "prompt", text: "still there?" });
		const r = await c.next((f) => f.event === "agent:stream" && f.payload.final);
		expect(r.payload.chunk).toBe("echo: still there?");

		c.send({ type: "session:detach" });
		await c.next((f) => f.type === "session:detached");
		c.send({ type: "prompt", text: "nobody home" });
		await c.next((f) => f.type === "error" && f.message === "no active session");
		expect(pool.hasSession("s_shared")).toBe(true);
		c.close();
	});

	it("refuses traversal ids and sessions it may not share", async () => {
		pool.createSession("s_tg", "telegram");
		const c = new Client(server.port as number);
		await c.ready;
		c.send({ type: "session:attach", sessionId: "../../etc/passwd" });
		await c.next((f) => f.type === "error" && f.message === "invalid session id");
		c.send({ type: "session:attach", sessionId: "s_tg" });
		await c.next((f) => f.type === "error" && f.message === "session cannot be shared");
		c.send({ type: "session:list" });
		const list = await c.next((f) => f.type === "session:list");
		expect(list.live.map((l: Frame) => l.sessionId)).not.toContain("s_tg");
		c.close();
	});
});
