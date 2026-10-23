/**
 * Bun.serve on Node (bun-serve.ts): the HTTP and RFC 6455 behaviour the daemon
 * gateway leans on, driven over a raw TCP socket so the frames are the ones a
 * real client sends: masked, fragmented, pinged, oversized.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import {
	MAX_WS_MESSAGE,
	type NodeServer,
	type NodeWebSocket,
	decodeFrame,
	encodeFrame,
	serve,
} from "./bun-serve";

let servers: NodeServer[] = [];
afterEach(() => {
	for (const s of servers) s.stop(true);
	servers = [];
});

function start(extra: Partial<Parameters<typeof serve>[0]> = {}) {
	const events: string[] = [];
	const sockets: NodeWebSocket[] = [];
	const s = serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				return server.upgrade(req, { data: { route: "t" } })
					? undefined
					: new Response("upgrade required", { status: 426 });
			}
			if (url.pathname === "/echo")
				return req.text().then((t) => new Response(`${req.method}:${t}`));
			if (url.pathname === "/ip") return Response.json(server.requestIP(req));
			if (url.pathname === "/cookies") {
				const h = new Headers({ "content-type": "text/plain" });
				h.append("set-cookie", "a=1");
				h.append("set-cookie", "b=2");
				return new Response("ok", { headers: h });
			}
			if (url.pathname === "/stream") {
				return new Response(
					new ReadableStream({
						async start(c) {
							for (const p of ["one,", "two,", "three"]) {
								c.enqueue(new TextEncoder().encode(p));
								await Bun.sleep(5);
							}
							c.close();
						},
					}),
				);
			}
			if (url.pathname === "/upgrade-on-plain") return new Response(String(server.upgrade(req)));
			if (url.pathname === "/throws") throw new Error("boom");
			return undefined;
		},
		websocket: {
			open(ws) {
				sockets.push(ws);
				events.push(`open:${JSON.stringify(ws.data)}:${ws.remoteAddress}`);
			},
			message(ws, m) {
				const text = typeof m === "string" ? `s:${m}` : `b:${m.length}`;
				events.push(text);
				if (typeof m === "string" && m === "bye") ws.close(4001, "later");
				else ws.send(typeof m === "string" ? `echo:${m}` : m);
			},
			close(_ws, code) {
				events.push(`close:${code}`);
			},
		},
		...extra,
	});
	servers.push(s);
	return { port: s.port, events, sockets, server: s };
}

const wait = async (fn: () => boolean) => {
	for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(20);
	expect(fn()).toBe(true);
};

/** A masked client frame. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
	const mask = randomBytes(4);
	const n = payload.length;
	const head =
		n < 126
			? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n])
			: n < 65536
				? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, n >> 8, n & 0xff])
				: (() => {
						const h = Buffer.alloc(10);
						h[0] = (fin ? 0x80 : 0) | opcode;
						h[1] = 0x80 | 127;
						h.writeBigUInt64BE(BigInt(n), 2);
						return h;
					})();
	const body = Buffer.from(payload);
	for (let i = 0; i < body.length; i++) body[i] = (body[i] as number) ^ (mask[i % 4] as number);
	return Buffer.concat([head, mask, body]);
}

async function wsClient(port: number, path = "/ws") {
	const sock = connect(port, "127.0.0.1");
	let buf = Buffer.alloc(0);
	sock.on("data", (d) => void (buf = Buffer.concat([buf, d])));
	const key = randomBytes(16).toString("base64");
	sock.write(
		`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	await wait(() => buf.includes("\r\n\r\n"));
	const end = buf.indexOf("\r\n\r\n") + 4;
	const head = buf.subarray(0, end).toString();
	buf = buf.subarray(end);
	const out: { opcode: number; payload: Buffer }[] = [];
	/** Every frame received so far (idempotent: safe to call from a polling predicate). */
	const frames = () => {
		for (;;) {
			// server frames are unmasked, so decode by hand
			if (buf.length < 2) break;
			let len = (buf[1] as number) & 0x7f;
			let off = 2;
			if (len === 126) {
				len = buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				len = Number(buf.readBigUInt64BE(2));
				off = 10;
			}
			if (buf.length < off + len) break;
			out.push({ opcode: (buf[0] as number) & 0x0f, payload: buf.subarray(off, off + len) });
			buf = buf.subarray(off + len);
		}
		return out;
	};
	return { sock, head, key, frames, closed: () => sock.destroyed || sock.readableEnded };
}

describe("frame codec", () => {
	test("round-trips 7-bit, 16-bit and 64-bit lengths", () => {
		for (const n of [0, 5, 125, 126, 300, 65535, 65536, 70000]) {
			const p = randomBytes(n);
			const r = decodeFrame(clientFrame(0x2, p));
			expect(r).not.toBeString();
			const got = (r as { frame: { payload: Buffer }; used: number }).frame.payload;
			expect(got.equals(p)).toBe(true);
			// and the server encoder's header length matches
			expect(encodeFrame(0x2, p).length).toBe(n + (n < 126 ? 2 : n < 65536 ? 4 : 10));
		}
	});
	test("needs more bytes, rejects unmasked, RSV bits, and oversize", () => {
		expect(decodeFrame(Buffer.from([0x81]))).toBe("need-more");
		expect(decodeFrame(clientFrame(0x1, Buffer.from("hello")).subarray(0, 6))).toBe("need-more");
		expect(decodeFrame(Buffer.from([0x81, 0x05, 1, 2, 3, 4, 5]))).toBe("protocol");
		expect(decodeFrame(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]))).toBe("protocol");
		const big = Buffer.alloc(10);
		big[0] = 0x82;
		big[1] = 0x80 | 127;
		big.writeBigUInt64BE(BigInt(MAX_WS_MESSAGE) + 1n, 2);
		expect(decodeFrame(Buffer.concat([big, Buffer.alloc(4)]))).toBe("too-big");
	});
});

describe("http", () => {
	test("routes, bodies, status and fall-through 404", async () => {
		const { port } = start();
		expect(
			await (await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", body: "hi" })).text(),
		).toBe("POST:hi");
		expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/throws`)).status).toBe(500);
	});
	test("requestIP names the peer", async () => {
		const { port } = start();
		const ip = (await (await fetch(`http://127.0.0.1:${port}/ip`)).json()) as { address: string };
		expect(["127.0.0.1", "::ffff:127.0.0.1"]).toContain(ip.address);
	});
	test("keeps each Set-Cookie and streams a chunked body", async () => {
		const { port } = start();
		const r = await fetch(`http://127.0.0.1:${port}/cookies`);
		expect(r.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		expect(await (await fetch(`http://127.0.0.1:${port}/stream`)).text()).toBe("one,two,three");
	});
	test("upgrade() on a plain request is false, as in Bun", async () => {
		const { port } = start();
		expect(await (await fetch(`http://127.0.0.1:${port}/upgrade-on-plain`)).text()).toBe("false");
	});
	test("binds the hostname it was given and reports the real port", () => {
		const { port, server } = start();
		expect(server.hostname).toBe("127.0.0.1");
		expect(port).toBeGreaterThan(0);
	});
});

describe("websocket", () => {
	test("handshake returns the RFC 6455 accept key; data and remoteAddress reach open()", async () => {
		const { port, events } = start();
		const c = await wsClient(port);
		const accept = createHash("sha1")
			.update(`${c.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		expect(c.head).toStartWith("HTTP/1.1 101");
		expect(c.head).toContain(`Sec-WebSocket-Accept: ${accept}`);
		await wait(() => events.some((e) => e.startsWith("open:")));
		expect(events[0]).toMatch(/^open:\{"route":"t"\}:(127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
		c.sock.destroy();
	});

	test("text and binary messages, in both directions, across all length classes", async () => {
		const { port, events } = start();
		const c = await wsClient(port);
		c.sock.write(clientFrame(0x1, Buffer.from("héllo")));
		await wait(() => events.includes("s:héllo"));
		const bin = randomBytes(70000);
		c.sock.write(clientFrame(0x2, bin));
		await wait(() => events.includes("b:70000"));
		await wait(() => c.frames().length >= 2);
		const got = c.frames();
		expect(got[0]?.opcode).toBe(0x1);
		expect(got[0]?.payload.toString()).toBe("echo:héllo");
		expect(got[1]?.opcode).toBe(0x2);
		expect(got[1]?.payload.equals(bin)).toBe(true);
		c.sock.destroy();
	});

	test("a fragmented message arrives whole, with a ping in the middle answered by a pong", async () => {
		const { port, events } = start();
		const c = await wsClient(port);
		c.sock.write(clientFrame(0x1, Buffer.from("frag"), false));
		c.sock.write(clientFrame(0x9, Buffer.from("p")));
		c.sock.write(clientFrame(0x0, Buffer.from("men"), false));
		c.sock.write(clientFrame(0x0, Buffer.from("ted"), true));
		await wait(() => events.includes("s:fragmented"));
		await wait(() => c.frames().some((x) => x.opcode === 0xa));
		const f = c.frames();
		expect(f.some((x) => x.opcode === 0xa && x.payload.toString() === "p")).toBe(true);
		c.sock.destroy();
	});

	test("a frame split across TCP chunks and two frames in one chunk both parse", async () => {
		const { port, events } = start();
		const c = await wsClient(port);
		const a = clientFrame(0x1, Buffer.from("split-me"));
		c.sock.write(a.subarray(0, 3));
		await Bun.sleep(30);
		c.sock.write(Buffer.concat([a.subarray(3), clientFrame(0x1, Buffer.from("second"))]));
		await wait(() => events.includes("s:split-me") && events.includes("s:second"));
		c.sock.destroy();
	});

	test("server close() sends a close frame with code and reason and fires close()", async () => {
		const { port, events } = start();
		const c = await wsClient(port);
		c.sock.write(clientFrame(0x1, Buffer.from("bye")));
		await wait(() => c.frames().some((x) => x.opcode === 0x8));
		const closeFrame = c.frames().find((x) => x.opcode === 0x8);
		expect(closeFrame?.payload.readUInt16BE(0)).toBe(4001);
		expect(closeFrame?.payload.subarray(2).toString()).toBe("later");
		c.sock.write(clientFrame(0x8, Buffer.from([0x0f, 0xa1]))); // client answers 4001
		await wait(() => events.includes("close:4001"));
		c.sock.destroy();
	});

	test("a client close is echoed and fires close() with its code", async () => {
		const { port, events } = start();
		const c = await wsClient(port);
		c.sock.write(clientFrame(0x8, Buffer.from([0x03, 0xe9]))); // 1001
		await wait(() => events.includes("close:1001"));
		await wait(() => c.frames().some((x) => x.opcode === 0x8));
		c.sock.destroy();
	});

	test("an unmasked frame closes with 1002 and still fires close()", async () => {
		const { port, events } = start();
		const c = await wsClient(port);
		c.sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
		await wait(() =>
			c.frames().some((x) => x.opcode === 0x8 && x.payload.readUInt16BE(0) === 1002),
		);
		c.sock.destroy();
		await wait(() => events.some((e) => e.startsWith("close:")));
		c.sock.destroy();
	});

	test("an oversized declared length closes with 1009 without buffering it", async () => {
		const { port } = start();
		const c = await wsClient(port);
		const h = Buffer.alloc(14);
		h[0] = 0x82;
		h[1] = 0x80 | 127;
		h.writeBigUInt64BE(BigInt(MAX_WS_MESSAGE) + 1n, 2);
		c.sock.write(h);
		await wait(() =>
			c.frames().some((x) => x.opcode === 0x8 && x.payload.readUInt16BE(0) === 1009),
		);
		c.sock.destroy();
	});

	test("a refused upgrade is answered as plain HTTP (426), and a non-WebSocket Upgrade is 400", async () => {
		const { port } = start({
			fetch: (req) =>
				new URL(req.url).pathname === "/ws" ? new Response("no", { status: 403 }) : undefined,
		});
		const c = await wsClient(port).catch(() => null);
		expect(c?.head ?? "").toStartWith("HTTP/1.1 403");
		c?.sock.destroy();
		const sock = connect(port, "127.0.0.1");
		let out = "";
		sock.on("data", (d) => void (out += d));
		sock.write(
			"GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
		);
		await wait(() => out.startsWith("HTTP/1.1 400"));
		sock.destroy();
	});

	test("a standard client (Bun's WebSocket) attaches, sends and receives", async () => {
		const { port } = start();
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const reply = await new Promise<string>((res, rej) => {
			ws.onopen = () => ws.send("ping-from-client");
			ws.onmessage = (e) => res(String(e.data));
			ws.onerror = () => rej(new Error("ws error"));
		});
		expect(reply).toBe("echo:ping-from-client");
		ws.close();
	});
});
