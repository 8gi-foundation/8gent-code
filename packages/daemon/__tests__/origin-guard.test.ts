/**
 * The gateway refuses web pages that are not ours, foreign Host headers, and a
 * network-wide bind without a token. Pure checks first, then the real gateway.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	UnsafeBindError,
	assertSafeBind,
	guardRequest,
	hostAllowed,
	originAllowed,
	resolveBindHost,
} from "../origin-guard";

describe("origin and host rules", () => {
	it("binds to 127.0.0.1 unless DAEMON_HOSTNAME says otherwise", () => {
		expect(resolveBindHost({})).toBe("127.0.0.1");
		expect(resolveBindHost({ DAEMON_HOSTNAME: "0.0.0.0" })).toBe("0.0.0.0");
	});

	it("refuses a non-loopback bind without a token", () => {
		expect(() => assertSafeBind("0.0.0.0", null)).toThrow(UnsafeBindError);
		expect(() => assertSafeBind("0.0.0.0", "t0k3n")).not.toThrow();
		expect(() => assertSafeBind("127.0.0.1", null)).not.toThrow();
	});

	it("allows native clients, loopback pages and eight:// pages; refuses the rest", () => {
		expect(originAllowed(null, {})).toBe(true);
		expect(originAllowed("http://localhost:3000", {})).toBe(true);
		expect(originAllowed("http://127.0.0.1:18789", {})).toBe(true);
		expect(originAllowed("eight://newtab", {})).toBe(true);
		expect(originAllowed("https://evil.example", {})).toBe(false);
		expect(originAllowed("http://localhost.evil.example", {})).toBe(false);
		expect(originAllowed("null", {})).toBe(false);
		expect(originAllowed("file://", {})).toBe(false);
		expect(
			originAllowed("https://os.8gi.org", { EIGHT_DAEMON_ALLOWED_ORIGINS: "https://os.8gi.org" }),
		).toBe(true);
	});

	it("allows loopback Host headers and refuses rebinding names", () => {
		expect(hostAllowed("127.0.0.1:18789", "127.0.0.1", {})).toBe(true);
		expect(hostAllowed("localhost:18789", "127.0.0.1", {})).toBe(true);
		expect(hostAllowed("[::1]:18789", "127.0.0.1", {})).toBe(true);
		expect(hostAllowed("rebind.evil.example:18789", "127.0.0.1", {})).toBe(false);
		expect(hostAllowed(null, "127.0.0.1", {})).toBe(false);
		expect(hostAllowed("10.0.0.5:18789", "10.0.0.5", {})).toBe(true);
		expect(
			hostAllowed("box.example:18789", "0.0.0.0", { EIGHT_DAEMON_ALLOWED_HOSTS: "box.example" }),
		).toBe(true);
	});

	it("guardRequest answers 403 for a foreign origin", () => {
		const req = new Request("http://127.0.0.1:18789/", {
			headers: { origin: "https://evil.example" },
		});
		expect(guardRequest(req, "127.0.0.1", {})?.status).toBe(403);
	});
});

describe("the real gateway", () => {
	const port = 19000 + Math.floor(Math.random() * 500);
	let server: { stop: () => void } | null = null;

	beforeAll(async () => {
		const { startGateway } = await import("../gateway");
		const stubPool = {
			size: 0,
			getStatus: () => ({}),
			createSession: () => {},
			chat: async () => "",
			destroySession: () => {},
			getActiveSessions: () => [],
		};
		// biome-ignore lint/suspicious/noExplicitAny: stub pool, only /health and the upgrade are exercised
		server = startGateway({ port, authToken: null, pool: stubPool as any });
	});
	afterAll(() => server?.stop());

	it("serves a native client with no Origin", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/health`);
		expect(res.status).toBe(200);
	});

	it("refuses a WebSocket upgrade from https://evil.example with 403", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/`, {
			headers: {
				origin: "https://evil.example",
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		expect(res.status).toBe(403);
	});

	it("refuses a rebinding Host header with 403", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/health`, {
			headers: { host: `rebind.evil.example:${port}` },
		});
		expect(res.status).toBe(403);
	});

	it("opens a session for a WebSocket with no Origin", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const frame = await new Promise<string>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("no frame")), 5000);
			ws.onopen = () => ws.send(JSON.stringify({ type: "session:create", channel: "browser" }));
			ws.onmessage = (e) => {
				clearTimeout(t);
				resolve(String(e.data));
			};
			ws.onerror = () => reject(new Error("socket error"));
		});
		ws.close();
		expect(JSON.parse(frame).type).toBe("session:created");
	});
});
