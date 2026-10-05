/**
 * Telegram reconnect resume (#3538).
 *
 * A real gateway on a loopback port, a recording fake pool, and the two
 * sockets the Telegram bridge actually opens in its default (multi-step)
 * mode: the bridge's own `ws` and the DaemonClient the task adapter uses.
 * Each reconnect used to send session:create and leak one never-evicted
 * telegram agent; these tests pin resume-on-reconnect and destroy-on-reset.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DaemonClient } from "../telegram-bot/daemon-client";
import type { AgentPool } from "./agent-pool";
import { startGateway } from "./gateway";
import { TelegramDaemonBridge } from "./telegram-bridge";

class RecordingPool {
	live = new Map<string, string>();
	created: Array<{ id: string; channel: string }> = [];
	destroyed: string[] = [];
	size = 0;
	createSession(id: string, channel: string) {
		this.created.push({ id, channel });
		this.live.set(id, channel);
	}
	resumes = 0;
	hasSession(id: string) {
		this.resumes++;
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.destroyed.push(id);
		this.live.delete(id);
	}
	getActiveSessions() {
		return [];
	}
	getStatus() {
		return {};
	}
	telegramCount() {
		return [...this.live.values()].filter((c) => c === "telegram").length;
	}
}

const pool = new RecordingPool();
let server: ReturnType<typeof Bun.serve>;
let url: string;
const prevHost = process.env.DAEMON_HOSTNAME;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 10));
	}
}

beforeAll(() => {
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	server = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
	url = `ws://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	if (prevHost === undefined) delete process.env.DAEMON_HOSTNAME;
	else process.env.DAEMON_HOSTNAME = prevHost;
});

function reset() {
	pool.live.clear();
	pool.created.length = 0;
	pool.destroyed.length = 0;
	pool.resumes = 0;
}

describe("DaemonClient against the real gateway", () => {
	it("keeps one telegram agent across repeated reconnects", async () => {
		reset();
		const client = new DaemonClient({ url, channel: "telegram", reconnectDelayMs: 10 });
		await client.connect();
		await until(() => pool.created.length === 1);
		const id = client.getSessionId();

		for (let i = 0; i < 3; i++) {
			(client as unknown as { ws: WebSocket }).ws.close();
			await new Promise((r) => setTimeout(r, 30));
			await client.connect();
		}

		expect(client.getSessionId()).toBe(id);
		expect(pool.created.length).toBe(1);
		expect(pool.telegramCount()).toBe(1);
		client.close();
	});

	it("recreates a lost session under the telegram channel, not api", async () => {
		reset();
		const client = new DaemonClient({ url, channel: "telegram", reconnectDelayMs: 10 });
		await client.connect();
		await until(() => pool.created.length === 1);
		const id = client.getSessionId() as string;

		// Simulate the daemon having lost the agent (restart, crash).
		pool.live.clear();
		(client as unknown as { ws: WebSocket }).ws.close();
		await new Promise((r) => setTimeout(r, 30));
		await client.connect();

		expect(pool.created.at(-1)).toEqual({ id, channel: "telegram" });
		client.close();
	});

	it("resetSession destroys the old agent", async () => {
		reset();
		const client = new DaemonClient({ url, channel: "telegram", reconnectDelayMs: 10 });
		await client.connect();
		await until(() => pool.created.length === 1);
		const old = client.getSessionId() as string;

		client.resetSession();
		await until(() => pool.created.length === 2);

		expect(pool.destroyed).toEqual([old]);
		expect(pool.telegramCount()).toBe(1);
		client.close();
	});
});

describe("TelegramDaemonBridge daemon socket against the real gateway", () => {
	it("resumes its session on reconnect", async () => {
		reset();
		const bridge = new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: "1",
			daemonUrl: url,
			authorizedChatIds: ["1"],
		});
		const b = bridge as unknown as {
			connectDaemon(): Promise<void>;
			ws: WebSocket | null;
			sessionId: string | null;
		};
		await b.connectDaemon();
		await until(() => pool.created.length === 1);
		const id = b.sessionId;

		b.ws?.close();
		// The bridge redials after its fixed 5 s delay. Wait for whichever frame
		// it sends on the new socket: a resume (fixed) or a second create (leak).
		await until(() => pool.resumes + pool.created.length >= 2, 8000);
		await new Promise((r) => setTimeout(r, 50));

		expect(b.sessionId).toBe(id);
		expect(pool.created.length).toBe(1);
		expect(pool.telegramCount()).toBe(1);

		// "New task" (and the legacy retry timer) replace the session: the old
		// agent must be destroyed, not abandoned.
		(bridge as unknown as { freshSession(): void }).freshSession();
		await until(() => pool.created.length === 2);
		expect(pool.destroyed).toEqual([id as string]);
		expect(pool.telegramCount()).toBe(1);

		// Detach the redial before closing so the test leaves no timer behind.
		if (b.ws) b.ws.onclose = null;
		b.ws?.close();
	}, 10000);
});
