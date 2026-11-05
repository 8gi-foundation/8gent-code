/** The gateway bounds what one prompt frame can put in memory: size, messageId, and type of `text`. */
import { afterAll, describe, expect, it } from "bun:test";
import type { AgentPool } from "./agent-pool";
import { startGateway } from "./gateway";

const MAX = 64 * 1024;

class Pool {
	chats: unknown[] = [];
	live = new Set<string>();
	get size() {
		return this.live.size;
	}
	createSession(id: string) {
		this.live.add(id);
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.live.delete(id);
	}
	getAgent() {
		return null;
	}
	getSessionInfo() {
		return { channel: "api", messageCount: 0, busy: false, createdAt: 1, lastActiveAt: 2 };
	}
	getActiveSessions() {
		return [];
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
	async chat(_sid: string, text: unknown) {
		this.chats.push(text);
		return "ok";
	}
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
	for (const s of servers) s.stop(true);
});

async function open() {
	const pool = new Pool();
	const server = startGateway({ port: 0, pool: pool as unknown as AgentPool, authToken: null });
	servers.push(server);
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
	const queue: Array<Record<string, unknown>> = [];
	let wake: (() => void) | null = null;
	ws.onmessage = (e) => {
		queue.push(JSON.parse(String(e.data)));
		wake?.();
	};
	await new Promise<void>((r) => {
		ws.onopen = () => r();
	});
	/** Next non-event frame. */
	const next = async () => {
		for (;;) {
			while (!queue.length) await new Promise<void>((r) => (wake = r));
			const m = queue.shift() as Record<string, unknown>;
			if (m.type !== "event") return m;
		}
	};
	ws.send(JSON.stringify({ type: "session:create", channel: "api" }));
	expect((await next()).type).toBe("session:created");
	return { ws, pool, next };
}

/** Send a frame then a probe; the probe's reply proves the frame was handled first. */
async function send(h: Awaited<ReturnType<typeof open>>, frame: object) {
	h.ws.send(JSON.stringify(frame));
	const reply = await h.next();
	h.ws.send(JSON.stringify({ type: "nonsense" }));
	return reply;
}

describe("prompt caps at the gateway", () => {
	it("refuses a prompt of 64 KiB + 1 byte and never reaches the pool", async () => {
		const h = await open();
		const r = await send(h, { type: "prompt", text: "a".repeat(MAX + 1) });
		expect(r.type).toBe("error");
		expect(String(r.message)).toContain("prompt too large");
		await h.next();
		expect(h.pool.chats).toHaveLength(0);
		h.ws.close();
	});

	it("counts bytes, not characters", async () => {
		const h = await open();
		const r = await send(h, { type: "prompt", text: "é".repeat(MAX / 2 + 1) });
		expect(String(r.message)).toContain("prompt too large");
		expect(h.pool.chats).toHaveLength(0);
		h.ws.close();
	});

	it("takes a prompt of exactly 64 KiB", async () => {
		const h = await open();
		h.ws.send(JSON.stringify({ type: "prompt", text: "a".repeat(MAX) }));
		for (let i = 0; i < 50 && h.pool.chats.length === 0; i++) await Bun.sleep(10);
		expect(h.pool.chats).toHaveLength(1);
		h.ws.close();
	});

	it("refuses a messageId of 129 characters, takes 128", async () => {
		const h = await open();
		const r = await send(h, { type: "prompt", text: "hi", messageId: "m".repeat(129) });
		expect(r.type).toBe("error");
		expect(String(r.message)).toContain("messageId too long");
		await h.next();
		expect(h.pool.chats).toHaveLength(0);
		h.ws.send(JSON.stringify({ type: "prompt", text: "hi", messageId: "m".repeat(128) }));
		for (let i = 0; i < 50 && h.pool.chats.length === 0; i++) await Bun.sleep(10);
		expect(h.pool.chats).toHaveLength(1);
		h.ws.close();
	});

	for (const [name, text] of [
		["an array", ["x".repeat(1000)]],
		["an object", { a: "x".repeat(1000) }],
		["a number", 5],
		["null", null],
		["missing", undefined],
	] as const) {
		it(`refuses non-string text (${name}) and never reaches the pool`, async () => {
			const h = await open();
			const r = await send(h, { type: "prompt", text });
			expect(r.type).toBe("error");
			expect(String(r.message)).toContain("text must be a string");
			await h.next();
			expect(h.pool.chats).toHaveLength(0);
			h.ws.close();
		});
	}
});
