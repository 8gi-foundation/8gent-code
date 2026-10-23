/**
 * #4834: the Telegram home session over a real gateway. A real bridge-registered
 * socket owns a telegram session; a second loopback socket (the TUI) tries to
 * join it. The pool is a stand-in whose turn echoes the prompt; routing, the
 * operator check, the attach rule, echo and persistence are the real gateway.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "./agent-pool";
import { bridgeSecret } from "./channel-approvals";
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
const OPERATOR = "c".repeat(64);

const pool = new EchoPool();
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const savedData = process.env.EIGHT_DATA_DIR;
const savedHost = process.env.DAEMON_HOSTNAME;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "home-gw-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	// The default daemon: no gateway-wide token, an operator token for the home session.
	server = startGateway({
		port: 0,
		authToken: null,
		operatorToken: OPERATOR,
		pool: pool as unknown as AgentPool,
	});
});

afterAll(() => {
	server.stop(true);
	if (savedData === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = savedData;
	if (savedHost === undefined) delete process.env.DAEMON_HOSTNAME;
	else process.env.DAEMON_HOSTNAME = savedHost;
	rmSync(dataDir, { recursive: true, force: true });
});

/** A bridge socket that owns the telegram session, like TelegramDaemonBridge.connectDaemon. */
async function bridge(declare = true): Promise<{ c: Client; sessionId: string }> {
	const c = new Client(server.port as number);
	await c.ready;
	c.send({ type: "approvals:register", secret: bridgeSecret() });
	await c.next((f) => f.type === "approvals:registered" && f.ok === true);
	c.send({ type: "session:create", channel: "telegram" });
	const created = await c.next((f) => f.type === "session:created");
	if (declare) c.send({ type: "home:declare" });
	return { c, sessionId: created.sessionId };
}

async function tui(token?: string): Promise<Client> {
	const c = new Client(server.port as number);
	await c.ready;
	if (token !== undefined) {
		c.send({ type: "auth", token });
		await c.next((f) => f.type === "auth:ok" || f.type === "auth:fail");
	}
	return c;
}

const sessionFiles = () =>
	existsSync(join(dataDir, "sessions")) ? readdirSync(join(dataDir, "sessions")) : [];

describe("the Telegram home session", () => {
	it("a loopback socket with no token, or a wrong one, cannot attach it by alias or by id", async () => {
		const b = await bridge();
		for (const token of [undefined, "wrong", "c".repeat(63), ""]) {
			const c = await tui(token);
			for (const sessionId of ["home", b.sessionId]) {
				c.frames.length = 0;
				c.send({ type: "session:attach", sessionId, channel: "tui" });
				const f = await c.next((x) => x.type === "error" || x.type === "session:attached");
				expect(f).toEqual({ type: "error", message: "operator token required" });
			}
			// Nor can it prompt into it: it never got bound.
			c.send({ type: "prompt", text: "hello from nobody" });
			await settle();
			expect(c.frames.some((x) => x.type === "event" && x.event === "agent:stream")).toBe(false);
			c.close();
		}
		expect(pool.getAgent(b.sessionId)!.history.length).toBe(1);
		b.c.close();
	});

	it("with the operator token it attaches, sees the transcript, and its prompt reaches the bridge socket labelled tui", async () => {
		const b = await bridge();
		pool.getAgent(b.sessionId)!.history.push({ role: "user", content: "said on telegram" });
		const c = await tui(OPERATOR);
		c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		const a = await c.next((f) => f.type === "session:attached");
		expect(a).toMatchObject({ sessionId: b.sessionId, channel: "telegram", home: true });
		expect(a.transcript.map((m: Frame) => m.content)).toEqual(["said on telegram"]);

		c.send({ type: "prompt", text: "typed in the tui" });
		const echoed = await b.c.next(
			(f) =>
				f.type === "event" && f.event === "user:message" && f.payload.text === "typed in the tui",
		);
		expect(echoed.payload.channel).toBe("tui");
		await c.next(
			(f) => f.type === "event" && f.event === "agent:stream" && f.payload.final === true,
		);
		c.close();
		b.c.close();
	});

	it("a Telegram prompt is echoed to the TUI with its channel", async () => {
		const b = await bridge();
		const c = await tui(OPERATOR);
		c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		await c.next((f) => f.type === "session:attached");
		b.c.send({ type: "prompt", text: "typed in telegram" });
		const echoed = await c.next(
			(f) =>
				f.type === "event" && f.event === "user:message" && f.payload.text === "typed in telegram",
		);
		expect(echoed.payload.channel).toBe("telegram");
		c.close();
		b.c.close();
	});

	it("is never listed, and the store never holds it, whatever the TUI does", async () => {
		const b = await bridge();
		const c = await tui(OPERATOR);
		c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		await c.next((f) => f.type === "session:attached");
		c.send({ type: "prompt", text: "persist me?" });
		await c.next(
			(f) => f.type === "event" && f.event === "agent:stream" && f.payload.final === true,
		);
		await settle();
		c.frames.length = 0;
		c.send({ type: "session:list" });
		const list = await c.next((f) => f.type === "session:list");
		expect(list.live.map((l: Frame) => l.sessionId)).not.toContain(b.sessionId);
		expect(list.past.map((l: Frame) => l.sessionId)).not.toContain(b.sessionId);
		expect(sessionFiles().filter((f) => f.includes(b.sessionId))).toEqual([]);
		c.close();
		b.c.close();
	});

	it("there is no home session until a registered bridge owns a telegram session", async () => {
		// A socket that creates a telegram session without proving it is the bridge is not home.
		const imposter = new Client(server.port as number);
		await imposter.ready;
		imposter.send({ type: "session:create", channel: "telegram" });
		await imposter.next((f) => f.type === "session:created");
		const c = await tui(OPERATOR);
		c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		const f = await c.next((x) => x.type === "error" || x.type === "session:attached");
		expect(f).toEqual({ type: "error", message: "no home session" });
		c.close();
		imposter.close();
	});

	it("a daemon with no operator token lets nobody attach it", async () => {
		const closed = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
		try {
			const b = new Client(closed.port as number);
			await b.ready;
			b.send({ type: "approvals:register", secret: bridgeSecret() });
			await b.next((f) => f.type === "approvals:registered");
			b.send({ type: "session:create", channel: "telegram" });
			await b.next((f) => f.type === "session:created");
			b.send({ type: "home:declare" });
			const c = new Client(closed.port as number);
			await c.ready;
			c.send({ type: "auth", token: OPERATOR });
			await c.next((f) => f.type === "auth:ok");
			c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
			expect(await c.next((f) => f.type === "error")).toEqual({
				type: "error",
				message: "operator token required",
			});
			c.close();
			b.close();
		} finally {
			closed.stop(true);
		}
	});

	it("when the gateway token is set it is the operator token", async () => {
		const gated = startGateway({
			port: 0,
			authToken: "t".repeat(64),
			pool: pool as unknown as AgentPool,
		});
		try {
			const b = new Client(gated.port as number);
			await b.ready;
			b.send({ type: "auth", token: "t".repeat(64) });
			await b.next((f) => f.type === "auth:ok");
			b.send({ type: "approvals:register", secret: bridgeSecret() });
			await b.next((f) => f.type === "approvals:registered");
			b.send({ type: "session:create", channel: "telegram" });
			const created = await b.next((f) => f.type === "session:created");
			b.send({ type: "home:declare" });
			const c = new Client(gated.port as number);
			await c.ready;
			c.send({ type: "auth", token: "t".repeat(64) });
			await c.next((f) => f.type === "auth:ok");
			c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
			expect((await c.next((f) => f.type === "session:attached")).sessionId).toBe(
				created.sessionId,
			);
			c.close();
			b.close();
		} finally {
			gated.stop(true);
		}
	});

	it("a bridge that has not declared a home leaves none, and only the bridge can declare", async () => {
		const quiet = await bridge(false);
		const c = await tui(OPERATOR);
		c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		expect(await c.next((f) => f.type === "error")).toEqual({
			type: "error",
			message: "no home session",
		});
		// A socket that is not the bridge cannot declare one, even for its own telegram session.
		const imposter = new Client(server.port as number);
		await imposter.ready;
		imposter.send({ type: "session:create", channel: "telegram" });
		await imposter.next((f) => f.type === "session:created");
		imposter.send({ type: "home:declare" });
		expect(await imposter.next((f) => f.type === "error")).toEqual({
			type: "error",
			message: "not-bridge",
		});
		c.frames.length = 0;
		c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		expect((await c.next((f) => f.type === "error")).message).toBe("no home session");
		c.close();
		imposter.close();
		quiet.c.close();
	});

	it("with two bridge sessions (legacy and the adapter's) the latest declaration is home", async () => {
		const legacy = await bridge(true);
		await settle();
		const adapter = await bridge(true);
		await settle();
		const c = await tui(OPERATOR);
		c.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		expect((await c.next((f) => f.type === "session:attached")).sessionId).toBe(adapter.sessionId);
		c.close();
		adapter.c.close();
		await settle();
		const c2 = await tui(OPERATOR);
		c2.send({ type: "session:attach", sessionId: "home", channel: "tui" });
		expect((await c2.next((f) => f.type === "session:attached")).sessionId).toBe(legacy.sessionId);
		c2.close();
		legacy.c.close();
	});
});
