/**
 * #3541: the proxy must not cut off slow answers, and must cancel the model
 * call when the client goes away.
 *
 * Real sockets on both sides: the proxy runs under Bun.serve on port 0 and the
 * "model" is a fake upstream (also Bun.serve on port 0) speaking either the
 * native Ollama shape (/api/chat) or the OpenAI-compatible shape
 * (/v1/chat/completions). No model, no network beyond 127.0.0.1.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetProviderManager } from "../../../packages/providers";
import { startServer } from "./server";

type Upstream = {
	server: ReturnType<typeof Bun.serve>;
	/** Resolves when the upstream receives a chat request. */
	received: () => Promise<void>;
	/** Resolves when the upstream sees its request's signal abort. */
	aborted: () => Promise<void>;
	/** How long the upstream waits before answering (ms). */
	delayMs: number;
};

function startUpstream(delayMs: number): Upstream {
	let onReceived: () => void = () => {};
	let onAborted: () => void = () => {};
	const receivedP = new Promise<void>((r) => (onReceived = r));
	const abortedP = new Promise<void>((r) => (onAborted = r));
	const up: Upstream = {
		delayMs,
		received: () => receivedP,
		aborted: () => abortedP,
		server: Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			async fetch(req) {
				onReceived();
				req.signal.addEventListener("abort", () => onAborted(), { once: true });
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, up.delayMs);
					req.signal.addEventListener("abort", () => {
						clearTimeout(t);
						resolve();
					});
				});
				const { pathname } = new URL(req.url);
				if (pathname === "/api/chat") {
					return Response.json({ message: { role: "assistant", content: "pong" }, done: true });
				}
				return Response.json({
					id: "x",
					object: "chat.completion",
					created: 0,
					model: "fake",
					choices: [
						{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
					],
				});
			},
		}),
	};
	return up;
}

let tmp: string;
const savedSettingsPath = process.env.EIGHT_PROVIDERS_SETTINGS_PATH;

function useProvider(kind: "ollama" | "lmstudio", upstream: Upstream) {
	const base = `http://127.0.0.1:${upstream.server.port}`;
	const settings = {
		activeProvider: kind,
		activeModel: "fake-model",
		providers:
			kind === "ollama"
				? { ollama: { enabled: true, baseUrl: base } }
				: { lmstudio: { enabled: true, baseUrl: `${base}/v1` } },
	};
	fs.writeFileSync(path.join(tmp, "providers.json"), JSON.stringify(settings));
	resetProviderManager();
}

const open: Array<{ stop: (force?: boolean) => unknown }> = [];

function chatBody() {
	return JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "ping" }] });
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${what} not seen within ${ms}ms`)), ms),
		),
	]);
}

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cancel-"));
	process.env.EIGHT_PROVIDERS_SETTINGS_PATH = path.join(tmp, "providers.json");
});

afterEach(() => {
	while (open.length) open.pop()?.stop(true);
});

afterAll(() => {
	if (savedSettingsPath === undefined)
		Reflect.deleteProperty(process.env, "EIGHT_PROVIDERS_SETTINGS_PATH");
	else process.env.EIGHT_PROVIDERS_SETTINGS_PATH = savedSettingsPath;
	resetProviderManager();
	fs.rmSync(tmp, { recursive: true, force: true });
});

type RawResult = { closedAt: number; respAt: number; data: string };

/**
 * Raw TCP client: write `payload`, record when "pong" arrives and when the
 * server closes the socket. Gives up (closedAt -1) after `capMs`.
 */
function raw(port: number, payload: string, capMs: number): Promise<RawResult> {
	const t0 = Date.now();
	const out: RawResult = { closedAt: -1, respAt: -1, data: "" };
	return new Promise((resolve) => {
		let sock: { end: () => void } | undefined;
		const cap = setTimeout(() => {
			sock?.end();
			resolve(out);
		}, capMs);
		Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				open(s) {
					sock = s;
					s.write(payload);
				},
				data(_s, d) {
					out.data += d.toString();
					if (out.respAt < 0 && out.data.includes("pong")) out.respAt = Date.now() - t0;
				},
				close() {
					clearTimeout(cap);
					out.closedAt = Date.now() - t0;
					resolve(out);
				},
				error() {},
			},
		});
	});
}

// The proxy keeps the server idle timeout and lifts it only while the chat
// request waits on the model. Run with a 1 s server idle timeout so the real
// socket behaviour shows in seconds (Bun closes idle sockets on a ~4 s tick at
// that setting). The default, 10 s, is covered by the opt-in slow test below.
describe("idle timeout over a raw socket (server idleTimeout 1 s)", () => {
	const GEN_MS = 5_500;
	let upstream: Upstream;
	let proxy: ReturnType<typeof startServer>;
	let stalled: Promise<RawResult>;
	let keepAlive: Promise<RawResult>;

	beforeAll(() => {
		upstream = startUpstream(GEN_MS);
		useProvider("ollama", upstream);
		proxy = startServer({ port: 0, idleTimeout: 1 });
		const body = chatBody();
		const port = Number(proxy.port);
		// Stalled body: claims 1000 bytes, sends one.
		stalled = raw(
			port,
			"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
			20_000,
		);
		// Keep-alive chat request whose model takes longer than the idle bound.
		keepAlive = raw(
			port,
			`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			20_000,
		);
	});

	afterAll(() => {
		proxy?.stop(true);
		upstream?.server.stop(true);
	});

	test("a stalled-body POST is still closed by the server idle timeout", async () => {
		const r = await stalled;
		expect(r.closedAt).toBeGreaterThan(0);
		expect(r.closedAt).toBeLessThan(GEN_MS);
	}, 25_000);

	test("a generation longer than the idle timeout is still delivered", async () => {
		const [s, k] = await Promise.all([stalled, keepAlive]);
		expect(k.data.startsWith("HTTP/1.1 200")).toBe(true);
		expect(k.respAt).toBeGreaterThanOrEqual(GEN_MS - 100);
		// The same server closed an idle socket before this answer arrived.
		expect(k.respAt).toBeGreaterThan(s.closedAt);
	}, 25_000);

	test("the keep-alive socket is closed again after the response", async () => {
		const k = await keepAlive;
		expect(k.closedAt).toBeGreaterThan(0);
		expect(k.closedAt - k.respAt).toBeLessThan(6_000);
	}, 25_000);
});

for (const kind of ["ollama", "lmstudio"] as const) {
	describe(`proxy over a real socket (${kind})`, () => {
		test("a normal request still returns the completion", async () => {
			const upstream = startUpstream(0);
			open.push(upstream.server);
			useProvider(kind, upstream);
			const proxy = startServer({ port: 0 });
			open.push(proxy);

			const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: chatBody(),
			});
			expect(r.status).toBe(200);
			const body = (await r.json()) as { choices: Array<{ message: { content: string } }> };
			expect(body.choices[0].message.content).toBe("pong");
		});

		test("a client disconnect aborts the upstream model call", async () => {
			// Upstream would hold for 8 s; the abort has to reach it well before.
			const upstream = startUpstream(8_000);
			open.push(upstream.server);
			useProvider(kind, upstream);
			const proxy = startServer({ port: 0 });
			open.push(proxy);

			const client = new AbortController();
			const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: chatBody(),
				signal: client.signal,
			}).catch(() => undefined);

			await within(upstream.received(), 3_000, "upstream request");
			client.abort();
			await within(upstream.aborted(), 3_000, "upstream abort");
			await pending;
		}, 15_000);
	});
}

// Real 12 s generation through the real server. Slow, so opt-in:
// EIGHT_SLOW_TESTS=1 bun test apps/proxy/src/cancel.test.ts
// Default 10 s server idle timeout. On Bun 1.4.2 a POST whose body was already
// read was not cut off at 10 s even before #3541 (a body-less request was), so
// this guards the shipped path rather than proving the lift.
test.skipIf(process.env.EIGHT_SLOW_TESTS !== "1")(
	"a reply that takes longer than 10 s is delivered, not cut off",
	async () => {
		const upstream = startUpstream(12_000);
		open.push(upstream.server);
		useProvider("ollama", upstream);
		const proxy = startServer({ port: 0 });
		open.push(proxy);

		const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: chatBody(),
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as { choices: Array<{ message: { content: string } }> };
		expect(body.choices[0].message.content).toBe("pong");
	},
	30_000,
);
