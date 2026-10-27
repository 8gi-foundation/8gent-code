/**
 * The `day8` channel: a session:create with it is accepted and gets the scope of
 * `api` (no wider); an unknown channel is still refused. Real WebSocket clients
 * on a real gateway, and a real AgentPool compared api vs day8.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_DEFAULT_CAPS } from "../permissions/dispatch-policy";
import { type AgentPool, KNOWN_CHANNELS } from "./agent-pool";
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

const TOKEN = "day8-test-token";
const savedData = process.env.EIGHT_DATA_DIR;
const savedHost = process.env.DAEMON_HOSTNAME;
let dataDir: string;
const pool = new StubPool();
let gw: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "day8-gw-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	gw = startGateway({ port: 0, authToken: TOKEN, pool: pool as unknown as AgentPool });
});

afterAll(() => {
	gw.stop(true);
	if (savedData === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = savedData;
	if (savedHost === undefined) Reflect.deleteProperty(process.env, "DAEMON_HOSTNAME");
	else process.env.DAEMON_HOSTNAME = savedHost;
	rmSync(dataDir, { recursive: true, force: true });
});

async function authed(): Promise<Client> {
	const c = new Client(gw.port as number);
	await c.ready;
	c.send({ type: "auth", token: TOKEN });
	await c.next((f) => f.type === "auth:ok");
	return c;
}

describe("day8 channel", () => {
	it("is in KNOWN_CHANNELS", () => {
		expect((KNOWN_CHANNELS as readonly string[]).includes("day8")).toBe(true);
	});

	it("session:create with channel day8 is accepted and created on day8", async () => {
		const c = await authed();
		c.send({ type: "session:create", channel: "day8" });
		const created = await c.next((f) => f.type === "session:created");
		expect(pool.live.get(created.sessionId)).toBe("day8");
		// Same frame as an api session: no classroom scope, no tool stripping.
		expect(created.scope).toBeUndefined();
		expect(created.tools).toBeUndefined();
		c.close();
	});

	it("an api session:created frame has the same keys as a day8 one", async () => {
		const c = await authed();
		c.send({ type: "session:create", channel: "api" });
		const a = await c.next((f) => f.type === "session:created");
		c.send({ type: "session:create", channel: "day8" });
		const d = await c.next((f) => f.type === "session:created" && f.sessionId !== a.sessionId);
		expect(Object.keys(d).sort()).toEqual(Object.keys(a).sort());
		expect(d.capabilities).toEqual(a.capabilities);
		c.close();
	});

	it("an unknown channel is still refused", async () => {
		const c = await authed();
		const before = pool.live.size;
		c.send({ type: "session:create", channel: "day9" });
		const err = await c.next((f) => f.type === "error");
		expect(err.message).toContain("unknown channel");
		expect(pool.live.size).toBe(before);
		c.close();
	});
});

describe("day8 scope equals api scope in the real pool", () => {
	it("the same caps, idle timeout, eviction and agent tool set", async () => {
		const { AgentPool: Real } = await import("./agent-pool");
		const p = new Real({ runtime: "ollama", model: "fake" });
		p.createSession("scope-api", "api");
		p.createSession("scope-day8", "day8");
		// biome-ignore lint/suspicious/noExplicitAny: reads private scope helpers
		const priv = p as any;
		expect(priv.capFor("day8")).toBe(priv.capFor("api"));
		expect(priv.idleTimeoutFor("day8")).toBe(priv.idleTimeoutFor("api"));
		const api = priv.sessions.get("scope-api");
		const d8 = priv.sessions.get("scope-day8");
		expect(priv.evictable("scope-day8", d8)).toBe(priv.evictable("scope-api", api));
		const toolNames = (e: { agent: { getTools?: () => Array<{ name: string }> } }) =>
			e.agent
				.getTools?.()
				.map((t) => t.name)
				.sort();
		expect(toolNames(d8)).toEqual(toolNames(api));
		p.destroySession("scope-api");
		p.destroySession("scope-day8");
	});

	it("the dispatch capability ceiling is the api row", () => {
		expect(CHANNEL_DEFAULT_CAPS.day8).toEqual(CHANNEL_DEFAULT_CAPS.api);
		expect(CHANNEL_DEFAULT_CAPS.day8).toEqual([]);
	});

	it("no channel-keyed table or branch in agent-pool or the policy engine names day8", () => {
		const pool = readFileSync(join(import.meta.dir, "agent-pool.ts"), "utf8");
		expect(pool.match(/["']day8["']/g)?.length).toBe(1);
		const policy = readFileSync(join(import.meta.dir, "../permissions/policy-engine.ts"), "utf8");
		expect(policy).not.toContain("day8");
		const shared = readFileSync(join(import.meta.dir, "shared-sessions.ts"), "utf8");
		expect(shared).not.toContain("day8");
	});
});
