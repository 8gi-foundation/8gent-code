/** #5031: a bad or throwing frame is an error reply, never the end of the daemon. */
import { afterAll, describe, expect, it } from "bun:test";
import type { AgentPool } from "./agent-pool";
import { startGateway } from "./gateway";

const AUTH = "2".repeat(64);
// No destroySession on purpose: ending a session then throws a TypeError inside the handler.
const pool = { size: 0, createSession: () => {} } as unknown as AgentPool;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
	for (const s of servers) s.stop(true);
});

async function open(authToken: string | null) {
	const server = startGateway({ port: 0, pool, authToken });
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
	const next = async () => {
		while (!queue.length) await new Promise<void>((r) => (wake = r));
		return queue.shift() as Record<string, unknown>;
	};
	return { ws, next };
}

describe("a bad frame gets an error reply and the socket keeps serving", () => {
	for (const [name, raw] of [
		["null", "null"],
		["a number", "5"],
		["a string", '"x"'],
		["an array", "[1]"],
		["an object without type", '{"a":1}'],
		["an object with a non-string type", '{"type":5}'],
	] as const) {
		it(name, async () => {
			const { ws, next } = await open(null);
			ws.send(raw);
			expect(await next()).toEqual({ type: "error", message: "bad frame" });
			ws.send("{nope");
			expect(await next()).toEqual({ type: "error", message: "invalid JSON" });
			ws.send(JSON.stringify({ type: "nonsense" }));
			expect(await next()).toEqual({ type: "error", message: "unknown message type" });
			ws.close();
		});
	}
});

describe("an authenticated frame whose handler throws", () => {
	it("gets the error frame, and the socket still answers", async () => {
		const { ws, next } = await open(AUTH);
		ws.send(JSON.stringify({ type: "auth", token: AUTH }));
		expect((await next()).type).toBe("auth:ok");
		ws.send(JSON.stringify({ type: "session:create", channel: "api" }));
		const created = await next();
		expect(created.type).toBe("session:created");
		ws.send(JSON.stringify({ type: "session:destroy", sessionId: created.sessionId }));
		let out = await next();
		while (out.type === "event") out = await next();
		expect(out.type).toBe("error");
		expect(String(out.message)).toContain("destroySession");
		ws.send(JSON.stringify({ type: "nonsense" }));
		expect(await next()).toEqual({ type: "error", message: "unknown message type" });
		ws.close();
	});
});
