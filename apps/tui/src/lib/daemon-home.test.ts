/**
 * #4834: the TUI finds a local daemon, joins the Telegram home session, and keeps
 * the link across a daemon restart. Real gateways and real sockets; the pool is a
 * stand-in, the bridge is a socket that registers with the real bridge secret.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "../../../../packages/daemon/agent-pool";
import { bridgeSecret } from "../../../../packages/daemon/channel-approvals";
import { bus } from "../../../../packages/daemon/events";
import { startGateway } from "../../../../packages/daemon/gateway";
import { ensureTokenFile, writeDiscovery } from "../../../../packages/daemon/local-link";
import {
	type DaemonChatEvent,
	DaemonSessionClient,
	daemonCandidates,
	resolveDaemonSecret,
} from "./daemon-sessions";

class Agent {
	history: Array<{ role: string; content: string }> = [{ role: "system", content: "sys" }];
	getMessageHistory() {
		return [...this.history];
	}
	restoreFromCheckpoint() {}
	abort() {}
	getWorkingDirectory() {
		return "/work";
	}
}
class Pool {
	live = new Map<string, { channel: string; agent: Agent }>();
	get size() {
		return this.live.size;
	}
	createSession(id: string, channel: string) {
		this.live.set(id, { channel, agent: new Agent() });
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
		return [...this.live].map(([sessionId, e]) => ({ sessionId, channel: e.channel }));
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
		bus.emit("agent:stream", { sessionId, chunk: `echo: ${text}`, final: true });
		return "ok";
	}
}

let root: string;
const saved = {
	data: process.env.EIGHT_DATA_DIR,
	host: process.env.DAEMON_HOSTNAME,
	url: process.env.EIGHT_DAEMON_URL,
	tok: process.env.EIGHT_DAEMON_TOKEN,
	home: process.env.HOME,
};
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const sockets: WebSocket[] = [];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "tui-home-"));
	process.env.EIGHT_DATA_DIR = join(root, "sessions-data");
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	delete process.env.EIGHT_DAEMON_URL;
	delete process.env.EIGHT_DAEMON_TOKEN;
});
afterEach(() => {
	for (const s of sockets.splice(0)) s.close();
	for (const s of servers.splice(0)) s.stop(true);
});
afterAll(() => {
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.data],
		["DAEMON_HOSTNAME", saved.host],
		["EIGHT_DAEMON_URL", saved.url],
		["EIGHT_DAEMON_TOKEN", saved.tok],
		["HOME", saved.home],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(root, { recursive: true, force: true });
});

/** A gateway like the daemon starts it: operator token from its own dir, no gateway token. */
function daemon(dir: string, port = 0) {
	mkdirSync(dir, { recursive: true });
	const operatorToken = ensureTokenFile(dir);
	const pool = new Pool();
	const server = startGateway({
		port,
		authToken: null,
		operatorToken,
		pool: pool as unknown as AgentPool,
	});
	servers.push(server);
	return { server, pool, url: `ws://127.0.0.1:${server.port}`, dir };
}

/** The Telegram bridge: registered, owns a telegram session, declares it home. */
async function bridge(url: string, history: string[] = []) {
	const ws = new WebSocket(url);
	sockets.push(ws);
	const frames: Array<Record<string, any>> = [];
	ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
	await new Promise<void>((r) => {
		ws.onopen = () => r();
	});
	ws.send(JSON.stringify({ type: "approvals:register", secret: bridgeSecret() }));
	ws.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
	const until = async (p: (f: Record<string, any>) => boolean) => {
		for (let i = 0; i < 200; i++) {
			const f = frames.find(p);
			if (f) return f;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error("no frame");
	};
	const created = await until((f) => f.type === "session:created");
	ws.send(JSON.stringify({ type: "home:declare" }));
	return { ws, sessionId: created.sessionId as string, frames, history };
}

const wait = async (ok: () => boolean, ms = 3000) => {
	const t = Date.now();
	while (!ok()) {
		if (Date.now() - t > ms) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 15));
	}
};

describe("which daemons the TUI tries", () => {
	it("EIGHT_DAEMON_URL names the one daemon", () => {
		expect(daemonCandidates({ EIGHT_DAEMON_URL: "ws://127.0.0.1:5", HOME: root })).toEqual([
			{ url: "ws://127.0.0.1:5" },
		]);
	});

	it("live daemons that wrote daemon.json, root first; a dead pid is ignored; else the default port", () => {
		const home = mkdtempSync(join(root, "h-"));
		expect(daemonCandidates({ HOME: home })).toEqual([{ url: "ws://127.0.0.1:18789" }]);
		const base = join(home, ".8gent");
		writeDiscovery(base, { url: "ws://127.0.0.1:18789", pid: process.pid, dataDir: base });
		const bot = join(base, "eightgent-data");
		writeDiscovery(bot, { url: "ws://127.0.0.1:18790", pid: process.pid, dataDir: bot });
		const dead = join(base, "gone");
		writeDiscovery(dead, { url: "ws://127.0.0.1:18791", pid: 2_147_483_000, dataDir: dead });
		expect(daemonCandidates({ HOME: home })).toEqual([
			{ url: "ws://127.0.0.1:18789", dir: base },
			{ url: "ws://127.0.0.1:18790", dir: bot },
		]);
	});

	it("a discovered daemon's token comes from its own directory", () => {
		const dir = mkdtempSync(join(root, "d-"));
		const t = ensureTokenFile(dir);
		expect(resolveDaemonSecret(root, dir)).toBe(t);
	});
});

describe("connectHome", () => {
	it("skips a daemon with no home session and joins the one that has it, each with its own token", async () => {
		const a = daemon(join(root, "a"));
		const b = daemon(join(root, "b"));
		const br = await bridge(b.url);
		b.pool.getAgent(br.sessionId)!.history.push({ role: "user", content: "said on telegram" });
		const { client, attached } = await DaemonSessionClient.connectHome({ reconnect: false }, [
			{ url: a.url, dir: a.dir },
			{ url: b.url, dir: b.dir },
		]);
		try {
			expect(attached).toMatchObject({ sessionId: br.sessionId, channel: "telegram", home: true });
			expect(attached.transcript.map((m) => m.content)).toEqual(["said on telegram"]);
			const seen: DaemonChatEvent[] = [];
			client.onEvent((e) => seen.push(e));
			br.ws.send(JSON.stringify({ type: "prompt", text: "typed in telegram" }));
			await wait(() => seen.some((e) => e.kind === "user"));
			expect(seen.find((e) => e.kind === "user")).toEqual({
				kind: "user",
				text: "typed in telegram",
				channel: "telegram",
			});
		} finally {
			client.close();
		}
	});

	it("says why when no daemon has a home session", async () => {
		const a = daemon(join(root, "none"));
		await expect(
			DaemonSessionClient.connectHome({ reconnect: false }, [{ url: a.url, dir: a.dir }]),
		).rejects.toThrow(/no home session/);
	});

	it("a daemon whose token file this user cannot match is refused, not trusted", async () => {
		const a = daemon(join(root, "mismatch"));
		const wrong = mkdtempSync(join(root, "w-"));
		ensureTokenFile(wrong);
		await expect(
			DaemonSessionClient.connectHome({ reconnect: false }, [{ url: a.url, dir: wrong }]),
		).rejects.toThrow(/not your 8gent daemon/);
	});
});

describe("the link survives a daemon restart", () => {
	const retry = { retryDelaysMs: [20, 20, 40] };

	it("reconnects, re-attaches home, replaces the transcript, and refuses sends meanwhile", async () => {
		const dir = join(root, "restart");
		const first = daemon(dir);
		const port = first.server.port as number;
		const br1 = await bridge(first.url);
		first.pool.getAgent(br1.sessionId)!.history.push({ role: "user", content: "before" });
		const { client } = await DaemonSessionClient.connectHome(retry, [{ url: first.url, dir }]);
		const seen: DaemonChatEvent[] = [];
		client.onEvent((e) => seen.push(e));
		try {
			br1.ws.close();
			first.server.stop(true);
			await wait(() => seen.some((e) => e.kind === "reconnecting"));
			expect(() => client.prompt("hello?")).toThrow(/reconnecting/);
			// The daemon comes back on the same port, with the same token file, and a bridge.
			const second = daemon(dir, port);
			const br2 = await bridge(second.url);
			second.pool.getAgent(br2.sessionId)!.history.push({ role: "user", content: "after" });
			await wait(() => seen.some((e) => e.kind === "resynced"));
			const re = seen.find((e) => e.kind === "resynced") as Extract<
				DaemonChatEvent,
				{ kind: "resynced" }
			>;
			expect(re.transcript.map((m) => m.content)).toEqual(["after"]);
			expect(seen.some((e) => e.kind === "ended")).toBe(false);
			// And it is live again: a send goes through and the reply comes back.
			client.prompt("are you there");
			await wait(() => seen.some((e) => e.kind === "reply"));
		} finally {
			client.close();
		}
	});

	it("detach during the outage stops the retry for good", async () => {
		const dir = join(root, "detach");
		const first = daemon(dir);
		const br = await bridge(first.url);
		const { client } = await DaemonSessionClient.connectHome(retry, [{ url: first.url, dir }]);
		const seen: DaemonChatEvent[] = [];
		client.onEvent((e) => seen.push(e));
		br.ws.close();
		first.server.stop(true);
		await wait(() => seen.some((e) => e.kind === "reconnecting"));
		await client.detach();
		const n = seen.length;
		await new Promise((r) => setTimeout(r, 200));
		expect(seen.length).toBe(n);
		expect(client.sessionId).toBeNull();
		client.close();
	});

	it("something else on the port after the restart ends the link and is sent nothing", async () => {
		const dir = join(root, "impostor");
		const first = daemon(dir);
		const port = first.server.port as number;
		const br = await bridge(first.url);
		const { client } = await DaemonSessionClient.connectHome(retry, [{ url: first.url, dir }]);
		const seen: DaemonChatEvent[] = [];
		client.onEvent((e) => seen.push(e));
		br.ws.close();
		first.server.stop(true);
		await wait(() => seen.some((e) => e.kind === "reconnecting"));
		const frames: string[] = [];
		const fake = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
			websocket: {
				message(ws, m) {
					frames.push(String(m));
					ws.send(JSON.stringify({ type: "identify:ok", proof: "0".repeat(64) }));
				},
			},
		});
		servers.push(fake);
		await wait(() => seen.some((e) => e.kind === "ended"));
		expect(frames.map((f) => JSON.parse(f).type)).toEqual(["identify"]);
		expect(JSON.stringify(frames)).not.toContain(ensureTokenFile(dir));
		client.close();
	});
});
