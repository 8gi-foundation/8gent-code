/**
 * #3929: the TUI's shared-session client against the real daemon gateway.
 * The pool is a stand-in that echoes; the sockets, frames and fan-out are real.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "../../../../packages/daemon/agent-pool";
import { bus } from "../../../../packages/daemon/events";
import { startGateway } from "../../../../packages/daemon/gateway";
import { SessionManager } from "../../../../packages/eight/session-manager";
import {
	type DaemonChatEvent,
	DaemonSessionClient,
	resolveDaemonSecret,
	toChatEvent,
} from "./daemon-sessions";

describe("toChatEvent", () => {
	it("shows prompts from other surfaces, final replies, tools and errors", () => {
		const ev = (event: string, payload: Record<string, unknown>) => ({
			type: "event",
			event,
			payload,
		});
		expect(toChatEvent(ev("user:message", { text: "hi", channel: "browser" }))).toEqual({
			kind: "user",
			text: "hi",
			channel: "browser",
		});
		expect(toChatEvent(ev("agent:stream", { chunk: "partial" }))).toBeNull();
		expect(toChatEvent(ev("agent:stream", { chunk: "all of it", final: true }))).toEqual({
			kind: "reply",
			text: "all of it",
		});
		expect(toChatEvent(ev("tool:start", { tool: "read_file" }))).toEqual({
			kind: "tool",
			tool: "read_file",
		});
		expect(toChatEvent(ev("agent:error", { error: "busy" }))).toEqual({
			kind: "error",
			text: "busy",
		});
		expect(toChatEvent(ev("session:end", { reason: "turn-complete" }))).toBeNull();
		expect(toChatEvent(ev("session:end", { reason: "idle-timeout" }))).toEqual({
			kind: "ended",
			reason: "idle-timeout",
		});
		expect(toChatEvent({ type: "pong" })).toBeNull();
		expect(toChatEvent(null)).toBeNull();
	});
});

class EchoAgent {
	history: Array<{ role: string; content: string }> = [{ role: "system", content: "sys" }];
	getMessageHistory() {
		return [...this.history];
	}
	restoreFromCheckpoint(m: Array<{ role: string; content: string }>) {
		this.history = [this.history[0], ...m];
	}
	abort() {}
	getWorkingDirectory() {
		return "/work";
	}
}

class EchoPool {
	live = new Map<string, { channel: string; agent: EchoAgent }>();
	get size() {
		return this.live.size;
	}
	createSession(id: string, channel: string) {
		this.live.set(id, { channel, agent: new EchoAgent() });
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
		return e
			? { channel: e.channel, messageCount: 0, busy: false, createdAt: 1, lastActiveAt: 2 }
			: null;
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
	async chat(sessionId: string, text: string) {
		const reply = `echo: ${text}`;
		this.live
			.get(sessionId)!
			.agent.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
		bus.emit("agent:stream", { sessionId, chunk: reply, final: true });
		return reply;
	}
}

const SECRET = "d".repeat(64);
const pool = new EchoPool();
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const saved = { data: process.env.EIGHT_DATA_DIR, host: process.env.DAEMON_HOSTNAME };

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "tui-shared-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	server = startGateway({
		port: 0,
		authToken: null,
		operatorToken: SECRET,
		pool: pool as unknown as AgentPool,
	});
});

afterAll(() => {
	server.stop(true);
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.data],
		["DAEMON_HOSTNAME", saved.host],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
});

async function until<T>(get: () => T | undefined, ms = 2000): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const v = get();
		if (v !== undefined) return v;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("timed out");
}

describe("DaemonSessionClient", () => {
	it("shares the TUI conversation with a second surface, both ways", async () => {
		// The TUI's own saved conversation, as its autosave writes it.
		const store = new SessionManager(join(dataDir, "sessions"));
		const mine = store.create({ cwd: dataDir });
		store.update(mine.id, [
			{ role: "user", content: "what is in this repo?" },
			{ role: "assistant", content: "a TUI" },
		]);

		const url = `ws://127.0.0.1:${server.port}`;
		const tui = await DaemonSessionClient.connect({ url, token: SECRET });
		const panel = await DaemonSessionClient.connect({ url, token: SECRET });

		// /sessions share: the TUI's session moves into the daemon.
		const shared = await tui.attach(mine.id, "tui");
		expect(shared).toMatchObject({ sessionId: mine.id, channel: "tui", restored: true });
		expect(shared.transcript.map((m) => m.content)).toEqual(["what is in this repo?", "a TUI"]);

		// The panel finds it as a live TUI session and joins with the history.
		const { live } = await panel.list();
		expect(live.find((s) => s.sessionId === mine.id)).toMatchObject({ channel: "tui", clients: 1 });
		const joined = await panel.attach(mine.id, "browser");
		expect(joined.restored).toBe(false);
		expect(joined.transcript.length).toBe(2);

		const tuiSaw: DaemonChatEvent[] = [];
		const panelSaw: DaemonChatEvent[] = [];
		tui.onEvent((e) => tuiSaw.push(e));
		panel.onEvent((e) => panelSaw.push(e));

		panel.prompt("open the README");
		await until(() => tuiSaw.find((e) => e.kind === "reply"));
		expect(tuiSaw).toEqual([
			{ kind: "user", text: "open the README", channel: "browser" },
			{ kind: "reply", text: "echo: open the README" },
		]);
		expect(panelSaw).toEqual([{ kind: "reply", text: "echo: open the README" }]);

		// The TUI detaching leaves the panel on the session.
		await tui.detach();
		panel.prompt("still here");
		await until(() => panelSaw.find((e) => e.kind === "reply" && e.text === "echo: still here"));
		expect(tuiSaw.length).toBe(2);
		expect(pool.hasSession(mine.id)).toBe(true);

		tui.close();
		panel.close();
	});

	it("rejects when no daemon is listening", async () => {
		await expect(
			DaemonSessionClient.connect({ url: "ws://127.0.0.1:9", token: SECRET, timeoutMs: 500 }),
		).rejects.toThrow(/no 8gent daemon/);
	});
});

/** A server that is not the daemon: records every frame it is sent. */
function fakeDaemon(onFrame: (ws: { send(s: string): void }, f: Record<string, unknown>) => void) {
	const frames: Array<Record<string, unknown>> = [];
	const srv = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, s) {
			return s.upgrade(req) ? undefined : new Response("not a daemon", { status: 404 });
		},
		websocket: {
			message(ws, raw) {
				const f = JSON.parse(String(raw));
				frames.push(f);
				onFrame(ws, f);
			},
		},
	});
	return { srv, frames, url: `ws://127.0.0.1:${srv.port}` };
}

describe("the daemon proves who it is before anything is sent (#4829)", () => {
	it("a server that answers with a wrong proof gets the challenge and nothing else", async () => {
		const fake = fakeDaemon((ws, f) => {
			if (f.type === "identify")
				ws.send(JSON.stringify({ type: "identify:ok", proof: "0".repeat(64) }));
			if (f.type === "auth") ws.send(JSON.stringify({ type: "auth:ok" }));
		});
		try {
			await expect(DaemonSessionClient.connect({ url: fake.url, token: SECRET })).rejects.toThrow(
				/not your 8gent daemon/,
			);
			expect(fake.frames.map((f) => f.type)).toEqual(["identify"]);
			expect(JSON.stringify(fake.frames)).not.toContain(SECRET);
		} finally {
			fake.srv.stop(true);
		}
	});

	it("a server that does not know the challenge (an old daemon, or another service) gets no token", async () => {
		const fake = fakeDaemon((ws) =>
			ws.send(JSON.stringify({ type: "error", message: "unknown message type" })),
		);
		try {
			await expect(DaemonSessionClient.connect({ url: fake.url, token: SECRET })).rejects.toThrow(
				/could not prove who it is/,
			);
			expect(fake.frames.map((f) => f.type)).toEqual(["identify"]);
			expect(JSON.stringify(fake.frames)).not.toContain(SECRET);
		} finally {
			fake.srv.stop(true);
		}
	});

	it("with no secret at all nothing is sent to anyone", async () => {
		const fake = fakeDaemon(() => {});
		try {
			await expect(DaemonSessionClient.connect({ url: fake.url, token: null })).rejects.toThrow(
				/no token to verify/,
			);
			expect(fake.frames).toEqual([]);
		} finally {
			fake.srv.stop(true);
		}
	});

	it("a real daemon with a different secret is refused", async () => {
		await expect(
			DaemonSessionClient.connect({ url: `ws://127.0.0.1:${server.port}`, token: "e".repeat(64) }),
		).rejects.toThrow(/not your 8gent daemon/);
	});

	it("a real daemon that has no identity secret is refused, and attach never happens", async () => {
		const bare = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
		try {
			await expect(
				DaemonSessionClient.connect({ url: `ws://127.0.0.1:${bare.port}`, token: SECRET }),
			).rejects.toThrow(/could not prove who it is/);
		} finally {
			bare.stop(true);
		}
	});

	it("the secret is found in the daemon's own token file when nothing is configured", async () => {
		const { ensureTokenFile } = await import("../../../../packages/daemon/local-link");
		const dir = mkdtempSync(join(tmpdir(), "tui-secret-"));
		const saved = { d: process.env.EIGHT_DATA_DIR, t: process.env.EIGHT_DAEMON_TOKEN };
		try {
			process.env.EIGHT_DATA_DIR = dir;
			delete process.env.EIGHT_DAEMON_TOKEN;
			expect(resolveDaemonSecret(dir)).toBeNull();
			const t = ensureTokenFile(dir);
			expect(resolveDaemonSecret(dir)).toBe(t);
			process.env.EIGHT_DAEMON_TOKEN = "f".repeat(64);
			expect(resolveDaemonSecret(dir)).toBe("f".repeat(64));
		} finally {
			for (const [k, v] of [
				["EIGHT_DATA_DIR", saved.d],
				["EIGHT_DAEMON_TOKEN", saved.t],
			] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
