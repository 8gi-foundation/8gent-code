/**
 * #3939: the gateway side of the `classroom` channel. Real WebSocket clients on
 * a real gateway; the pool is a stand-in that records which channel each
 * session was created on.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "./agent-pool";
import { bus } from "./events";
import { startGateway } from "./gateway";

class Agent {
	getMessageHistory() {
		return [
			{ role: "user", content: "lesson text" },
			{ role: "assistant", content: "{}" },
		];
	}
	getModel() {
		return "m";
	}
	getRuntime() {
		return "ollama";
	}
	getWorkingDirectory() {
		return "/w";
	}
	restoreFromCheckpoint() {}
}

class StubPool {
	live = new Map<string, string>();
	get size() {
		return this.live.size;
	}
	createSession(id: string, channel: string) {
		this.live.set(id, channel);
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.live.delete(id);
	}
	getAgent(id: string) {
		return this.live.has(id) ? new Agent() : null;
	}
	getSessionInfo(id: string) {
		const channel = this.live.get(id);
		return channel
			? { channel, messageCount: 0, busy: false, createdAt: 1, lastActiveAt: 2 }
			: null;
	}
	getActiveSessions() {
		return [...this.live].map(([sessionId, channel]) => ({
			sessionId,
			channel,
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
	async chat(sessionId: string, _text: string): Promise<string> {
		bus.emit("agent:stream", { sessionId, chunk: "{}", final: true });
		return "{}";
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
	close() {
		this.ws.close();
	}
}

const settle = () => new Promise((r) => setTimeout(r, 120));
const TOKEN = "classroom-test-token";
const savedData = process.env.EIGHT_DATA_DIR;
const savedHost = process.env.DAEMON_HOSTNAME;
let dataDir: string;
const authedPool = new StubPool();
const openPool = new StubPool();
let authed: ReturnType<typeof Bun.serve>;
let open: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "classroom-gw-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	authed = startGateway({ port: 0, authToken: TOKEN, pool: authedPool as unknown as AgentPool });
	open = startGateway({ port: 0, authToken: null, pool: openPool as unknown as AgentPool });
});

afterAll(() => {
	authed.stop(true);
	open.stop(true);
	if (savedData === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = savedData;
	if (savedHost === undefined) delete process.env.DAEMON_HOSTNAME;
	else process.env.DAEMON_HOSTNAME = savedHost;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("session:create {channel: classroom}", () => {
	it("is refused without the token", async () => {
		const c = new Client(authed.port as number);
		await c.ready;
		c.send({ type: "session:create", channel: "classroom" });
		await c.next((f) => f.type === "error" && f.message === "not authenticated");
		await settle();
		expect([...authedPool.live.values()]).not.toContain("classroom");
		c.close();
	});

	it("works from loopback on a daemon with no token, and dies with its socket", async () => {
		const c = new Client(open.port as number);
		await c.ready;
		c.send({ type: "session:create", channel: "classroom" });
		const created = await c.next((f) => f.type === "session:created");
		await settle();
		expect(openPool.live.get(created.sessionId)).toBe("classroom");
		c.close();
		await settle();
		expect(openPool.live.has(created.sessionId)).toBe(false);
	});

	it("works from loopback with the token, and nobody else can reach it", async () => {
		const owner = new Client(authed.port as number);
		const other = new Client(authed.port as number);
		await Promise.all([owner.ready, other.ready]);
		for (const c of [owner, other]) {
			c.send({ type: "auth", token: TOKEN });
			await c.next((f) => f.type === "auth:ok");
		}

		owner.send({ type: "session:create", channel: "classroom", persist: true });
		const created = await owner.next((f) => f.type === "session:created");
		const id = created.sessionId as string;
		await settle();
		expect(authedPool.live.get(id)).toBe("classroom");
		// The effective scope is echoed so the browser can fail closed.
		expect(created.scope).toBe("classroom");
		expect(created.tools).toEqual([]);

		// Not listed, not attachable, not resumable by another client.
		other.send({ type: "sessions:list" });
		const listed = await other.next((f) => f.type === "sessions:list");
		expect(JSON.stringify(listed.sessions)).not.toContain(id);
		other.send({ type: "session:list" });
		const shared = await other.next((f) => f.type === "session:list");
		expect(JSON.stringify(shared)).not.toContain(id);
		other.send({ type: "session:attach", sessionId: id, channel: "browser" });
		await other.next((f) => f.type === "error" && f.message === "session cannot be shared");
		other.send({ type: "session:resume", sessionId: id, resumeSecret: created.resumeSecret });
		await other.next((f) => f.type === "error" && f.message === "session cannot be shared");
		// The other client never became bound, so it cannot drive or end the session.
		other.send({ type: "prompt", text: "hello" });
		await other.next((f) => f.type === "error" && f.message === "no active session");
		other.send({ type: "session:destroy", sessionId: id });
		await other.next(
			(f) => f.type === "error" && f.message === "can only end the session you are on",
		);
		expect(authedPool.live.has(id)).toBe(true);

		// The owner can run a turn, and nothing is written to the session store,
		// even though it asked for persist.
		owner.send({ type: "prompt", text: "lesson text" });
		await owner.next((f) => f.event === "agent:stream" && f.payload.final);
		await settle();
		const files = (() => {
			try {
				return readdirSync(join(dataDir, "sessions"));
			} catch {
				return [];
			}
		})();
		expect(files).toEqual([]);

		owner.close();
		other.close();
	});

	it("refuses an unknown channel instead of defaulting it", async () => {
		const c = new Client(authed.port as number);
		await c.ready;
		c.send({ type: "auth", token: TOKEN });
		await c.next((f) => f.type === "auth:ok");
		const before = authedPool.live.size;
		c.send({ type: "session:create", channel: "classrom" });
		const err = await c.next((f) => f.type === "error");
		expect(err.message).toContain("unknown channel");
		await settle();
		expect(authedPool.live.size).toBe(before);
		c.close();
	});
});
