/**
 * #4829 (8SO block on #4830): a card-gated command in a daemon turn on the TUI
 * channel never runs without a yes. The real gateway starts the turn; the real
 * permission engine answers; the pool is a stand-in that only asks and echoes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permissions/index";
import type { AgentPool } from "./agent-pool";
import { bus } from "./events";
import { startGateway } from "./gateway";

const CARD_GATED = "python3 deploy.py --apply";

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
	/** What the permission engine answered for the card-gated command, per session. */
	answers = new Map<string, boolean>();
	async chat(sessionId: string, text: string): Promise<string> {
		const e = this.live.get(sessionId)!;
		// The real engine, asked the way run_command asks, inside the turn the gateway started.
		this.answers.set(
			sessionId,
			await new PermissionManager(join(dataDir, "permissions.json")).requestPermission(
				"run_command",
				"run a command",
				CARD_GATED,
			),
		);
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

const pool = new EchoPool();
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const saved = {
	data: process.env.EIGHT_DATA_DIR,
	host: process.env.DAEMON_HOSTNAME,
	headless: process.env.EIGHT_HEADLESS,
};

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "no-card-gw-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	process.env.EIGHT_HEADLESS = "1";
	server = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
});

afterAll(() => {
	server.stop(true);
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.data],
		["DAEMON_HOSTNAME", saved.host],
		["EIGHT_HEADLESS", saved.headless],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
});

async function turn(channel: string): Promise<boolean | undefined> {
	const c = new Client(server.port as number);
	await c.ready;
	c.send({ type: "session:create", channel });
	const created = await c.next((f) => f.type === "session:created");
	c.send({ type: "prompt", text: "do the thing" });
	await c.next((f) => f.type === "event" && f.event === "agent:stream" && f.payload.final === true);
	c.close();
	return pool.answers.get(created.sessionId);
}

describe("a daemon turn on the TUI channel", () => {
	it("refuses a card-gated command: it never runs without a yes", async () => {
		expect(await turn("tui")).toBe(false);
	});

	it("also when the session is a TUI session joined from another surface", async () => {
		const owner = new Client(server.port as number);
		await owner.ready;
		owner.send({ type: "session:create", channel: "tui" });
		const created = await owner.next((f) => f.type === "session:created");
		const other = new Client(server.port as number);
		await other.ready;
		other.send({ type: "session:attach", sessionId: created.sessionId, channel: "browser" });
		await other.next((f) => f.type === "session:attached");
		other.send({ type: "prompt", text: "from the panel" });
		await other.next(
			(f) => f.type === "event" && f.event === "agent:stream" && f.payload.final === true,
		);
		expect(pool.answers.get(created.sessionId)).toBe(false);
		owner.close();
		other.close();
	});

	it("leaves every other channel exactly as it was", async () => {
		expect(await turn("api")).toBe(true);
	});
});
