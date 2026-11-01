/**
 * #3929: two real WebSocket clients on one real gateway share a session.
 * The pool is a stand-in whose turn echoes the prompt; everything between the
 * sockets and the pool (routing, echo, fan-out, persistence, disconnect) is
 * the real gateway.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../eight/session-manager";
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
	canCreate() {
		return true;
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
		const file = join(dataDir, "sessions", "tree", "s_shared.jsonl");
		expect(existsSync(file)).toBe(true);
		const saved = new SessionManager(join(dataDir, "sessions")).get("s_shared")!;
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

	it("8PO repro: session:resume of a saved TUI session keeps its history and channel", async () => {
		const store = new SessionManager(join(dataDir, "sessions"));
		const tui = store.create({ cwd: dataDir });
		store.update(tui.id, [
			{ role: "user", content: "one" },
			{ role: "assistant", content: "two" },
			{ role: "user", content: "three" },
			{ role: "assistant", content: "four" },
		]);
		const browser = new Client(server.port as number);
		await browser.ready;
		browser.send({ type: "session:resume", sessionId: tui.id, channel: "browser" });
		const resumed = await browser.next((f) => f.type === "session:resumed");
		expect(resumed).toMatchObject({ restored: true, messageCount: 4 });
		browser.send({ type: "prompt", text: "five" });
		await browser.next((f) => f.event === "agent:stream" && f.payload.final);
		await settle();
		const file = join(dataDir, "sessions", "tree", `${tui.id}.jsonl`);
		const saved = new SessionManager(join(dataDir, "sessions")).get(tui.id)!;
		expect(saved.messages.map((m: Frame) => m.content)).toEqual([
			"one",
			"two",
			"three",
			"four",
			"five",
			"echo: five",
		]);
		expect(saved.channel).toBe("tui");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		browser.close();
	});

	it("a plain session that was never shared is not saved", async () => {
		const c = new Client(server.port as number);
		await c.ready;
		c.send({ type: "session:resume", sessionId: "s_private_browser", channel: "browser" });
		await c.next((f) => f.type === "session:resumed");
		c.send({ type: "prompt", text: "nobody else sees this" });
		await c.next((f) => f.event === "agent:stream" && f.payload.final);
		await settle();
		expect(existsSync(join(dataDir, "sessions", "s_private_browser.json"))).toBe(false);
		c.close();
	});

	it("destroy only ends your own session, and only when nobody else is on it", async () => {
		pool.createSession("s_two", "tui");
		pool.createSession("s_else", "tui");
		const a = new Client(server.port as number);
		const b = new Client(server.port as number);
		await Promise.all([a.ready, b.ready]);
		a.send({ type: "session:attach", sessionId: "s_two" });
		b.send({ type: "session:attach", sessionId: "s_two" });
		await a.next((f) => f.type === "session:attached");
		await b.next((f) => f.type === "session:attached");

		a.send({ type: "session:destroy", sessionId: "s_else" });
		await a.next((f) => f.type === "error" && f.message === "can only end the session you are on");
		expect(pool.hasSession("s_else")).toBe(true);

		// b is still on it: a's destroy only takes a off.
		a.send({ type: "session:destroy", sessionId: "s_two" });
		await settle();
		expect(pool.hasSession("s_two")).toBe(true);
		expect(b.events("session:end")).toEqual([]);
		a.send({ type: "prompt", text: "x" });
		await a.next((f) => f.type === "error" && f.message === "no active session");

		// The last one on it may end it.
		b.send({ type: "session:destroy", sessionId: "s_two" });
		await b.next((f) => f.event === "session:end" && f.payload.reason === "client-destroy");
		expect(pool.hasSession("s_two")).toBe(false);
		a.close();
		b.close();
	});

	it("abort is refused for a session the client is not on", async () => {
		pool.createSession("s_abort", "tui");
		const c = new Client(server.port as number);
		await c.ready;
		c.send({ type: "session:abort", sessionId: "s_abort" });
		await c.next((f) => f.type === "error");
		c.close();
	});

	it("persist: true saves a panel-only session, owner-only, and it survives a restart", async () => {
		const c = new Client(server.port as number);
		await c.ready;
		c.send({ type: "session:create", channel: "browser", persist: true });
		const created = await c.next((f) => f.type === "session:created");
		expect(created.resumeSecret).toMatch(/^[0-9a-f]{32}$/);
		const id = created.sessionId as string;
		await settle(); // the pool creates the agent on the next tick
		c.send({ type: "prompt", text: "remember the panel" });
		await c.next((f) => f.event === "agent:stream" && f.payload.final);
		await settle();
		const file = join(dataDir, "sessions", "tree", `${id}.jsonl`);
		expect(existsSync(file)).toBe(true);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		c.close();

		// Daemon restart: the pool is empty, the gateway is new.
		server.stop(true);
		pool.live.clear();
		server = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
		const again = new Client(server.port as number);
		await again.ready;
		again.send({ type: "session:resume", sessionId: id, channel: "browser" });
		const resumed = await again.next((f) => f.type === "session:resumed");
		expect(resumed).toMatchObject({ restored: true, messageCount: 2 });
		expect(resumed.resumeSecret).toMatch(/^[0-9a-f]{32}$/);
		expect(pool.getAgent(id)!.getMessageHistory().slice(1)).toEqual([
			{ role: "user", content: "remember the panel" },
			{ role: "assistant", content: "echo: remember the panel" },
		]);
		again.send({ type: "session:attach", sessionId: id });
		const att = await again.next((f) => f.type === "session:attached");
		expect(att.resumeSecret).toBe(resumed.resumeSecret);
		again.close();
	});

	it("a session created without persist (older clients) is still not saved", async () => {
		const c = new Client(server.port as number);
		await c.ready;
		c.send({ type: "session:create", channel: "browser" });
		const created = await c.next((f) => f.type === "session:created");
		await settle();
		c.send({ type: "prompt", text: "not kept" });
		await c.next((f) => f.event === "agent:stream" && f.payload.final);
		await settle();
		expect(existsSync(join(dataDir, "sessions", `${created.sessionId}.json`))).toBe(false);
		c.close();
	});
});
