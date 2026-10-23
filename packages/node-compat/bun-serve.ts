/**
 * Bun.serve on Node: the slice the daemon gateway uses (#4852).
 *
 * `fetch(req, server)`, `server.upgrade(req, { data })`, `server.requestIP(req)`,
 * `server.port`, `server.stop()`, and a `websocket: { open, message, close }`
 * handler set whose socket has `data`, `remoteAddress`, `readyState`, `send`
 * and `close`. Plain node:http plus a small RFC 6455 server, so the Node build
 * (Termux, where Bun does not run) needs no new dependency. Only used by the
 * Node bundle; under Bun nothing here loads.
 *
 * Not supported, and it fails loudly rather than pretending: permessage-deflate
 * (never offered in the handshake), and Bun's pub/sub and per-request timeouts.
 */
import { createHash } from "node:crypto";
import {
	type Server as HttpServer,
	type IncomingMessage,
	ServerResponse,
	createServer,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** A frame or reassembled message above this closes the socket with 1009. */
export const MAX_WS_MESSAGE = 16 * 1024 * 1024;
/** More fragments than this in one message closes the socket with 1009: each one costs memory beyond its bytes. */
export const MAX_WS_FRAGMENTS = 4096;
/** Partial frames and messages held by all connections together; past it the offender gets 1013. */
export const MAX_WS_TOTAL_BUFFERED = 128 * 1024 * 1024;
/** Unsent bytes queued for one peer that is not reading; past it that peer is closed with 1013. */
export const MAX_WS_BACKLOG = 32 * 1024 * 1024;
/** Open connections the server accepts at once (past it the OS-level accept is closed). */
export const MAX_CONNECTIONS = 1024;
/** Seconds of silence before a WebSocket peer is hung up on; Bun's default. */
export const DEFAULT_WS_IDLE_SECONDS = 120;

// biome-ignore lint/suspicious/noExplicitAny: mirrors Bun's loose handler shapes
type Loose = any;

export interface NodeWebSocket {
	data: Loose;
	remoteAddress: string;
	readyState: number;
	send(data: string | Uint8Array | ArrayBuffer): number;
	close(code?: number, reason?: string): void;
}

export interface ServeOptions {
	port?: number;
	hostname?: string;
	fetch(req: Request, server: NodeServer): Response | undefined | Promise<Response | undefined>;
	websocket?: {
		open?(ws: NodeWebSocket): void;
		message?(ws: NodeWebSocket, message: string | Buffer): void;
		close?(ws: NodeWebSocket, code: number, reason: string): void;
		/** Seconds of silence (pings are sent) before the peer is dropped. Default 120, as in Bun. */
		idleTimeout?: number;
	};
}

export interface NodeServer {
	readonly port: number;
	readonly hostname: string;
	upgrade(req: Request, opts?: { data?: Loose }): boolean;
	requestIP(req: Request): { address: string; family: string; port: number } | null;
	stop(closeActive?: boolean): void;
}

// ── frames ───────────────────────────────────────────────────────────────

/** One unmasked server-to-client frame. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const n = payload.length;
	const head =
		n < 126
			? Buffer.from([0x80 | opcode, n])
			: n < 65536
				? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
				: (() => {
						const h = Buffer.alloc(10);
						h[0] = 0x80 | opcode;
						h[1] = 127;
						h.writeBigUInt64BE(BigInt(n), 2);
						return h;
					})();
	return Buffer.concat([head, payload]);
}

export interface Frame {
	fin: boolean;
	opcode: number;
	payload: Buffer;
}

/**
 * How many bytes the client frame at the front of `buf` takes in all (header, mask, payload),
 * or what is wrong with it / that the header is not all here yet. Reads the header only.
 * Protocol errors named here: RSV bits, an unmasked frame, and the control-frame rules
 * (RFC 6455 5.5: never fragmented, payload of 125 bytes at most).
 */
export function frameSize(buf: Buffer): number | "need-more" | "protocol" | "too-big" {
	if (buf.length < 2) return "need-more";
	const b0 = buf[0] as number;
	const b1 = buf[1] as number;
	if (b0 & 0x70) return "protocol"; // RSV bits: no extension was negotiated
	if (!(b1 & 0x80)) return "protocol"; // clients must mask
	let len = b1 & 0x7f;
	let off = 2;
	if (len === 126) {
		if (buf.length < 4) return "need-more";
		len = buf.readUInt16BE(2);
		off = 4;
	} else if (len === 127) {
		if (buf.length < 10) return "need-more";
		const big = buf.readBigUInt64BE(2);
		if (big > BigInt(MAX_WS_MESSAGE)) return "too-big";
		len = Number(big);
		off = 10;
	}
	if ((b0 & 0x0f) >= 0x8 && (!(b0 & 0x80) || len > 125)) return "protocol";
	if (len > MAX_WS_MESSAGE) return "too-big";
	return off + 4 + len;
}

/** Pull one complete client frame off the front of `buf`, or report what is wrong / missing. */
export function decodeFrame(
	buf: Buffer,
): { frame: Frame; used: number } | "need-more" | "protocol" | "too-big" {
	const size = frameSize(buf);
	if (typeof size === "string") return size;
	if (buf.length < size) return "need-more";
	const b0 = buf[0] as number;
	const lenByte = (buf[1] as number) & 0x7f;
	const off = lenByte === 126 ? 4 : lenByte === 127 ? 10 : 2;
	const mask = buf.subarray(off, off + 4);
	const payload = Buffer.from(buf.subarray(off + 4, size));
	for (let i = 0; i < payload.length; i++)
		payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
	return { frame: { fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload }, used: size };
}

/** A message that is not valid UTF-8 closes the socket with 1007 (RFC 6455 8.1). */
const utf8 = new TextDecoder("utf-8", { fatal: true });
function decodeUtf8(b: Buffer): string | null {
	try {
		return utf8.decode(b);
	} catch {
		return null;
	}
}

/** Close codes a client may send (RFC 6455 7.4): anything else is a protocol error. */
function validClientCloseCode(c: number): boolean {
	return (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1011) || (c >= 3000 && c <= 4999);
}

/** Bytes held in partial frames and partial messages, across every connection. */
let totalBuffered = 0;

class ServerWebSocket implements NodeWebSocket {
	readyState = 1;
	private chunks: Buffer[] = [];
	private chunksLen = 0;
	/** Total bytes the frame at the front needs; nothing is joined before that many have arrived. */
	private need = 0;
	private parts: Buffer[] = [];
	private partsLen = 0;
	private partsOpcode = 0;
	private closeSent = false;
	/** After a protocol error nothing more is read or handled. */
	private dead = false;
	private held = 0;
	private lastSeen = Date.now();
	private readonly keepalive: ReturnType<typeof setInterval>;

	constructor(
		private readonly sock: Duplex,
		readonly data: Loose,
		readonly remoteAddress: string,
		private readonly handlers: NonNullable<ServeOptions["websocket"]>,
		idleTimeoutMs: number,
	) {
		sock.on("data", (chunk: Buffer) => this.onData(chunk));
		// node:http sockets allow half-open: a peer that closes its end (FIN) leaves the socket open
		// for good unless we hang up too, and the gateway never hears the client left.
		sock.on("end", () => {
			this.finish(1006, "");
			sock.destroy();
		});
		sock.on("close", () => this.finish(1006, ""));
		sock.on("error", () => this.finish(1006, ""));
		// A peer that goes silent is pinged, and hung up on if it does not answer: an idle
		// upgraded socket is never held for ever (Bun's idleTimeout, sendPings).
		this.keepalive = setInterval(
			() => {
				if (this.readyState === 3) return;
				if (Date.now() - this.lastSeen > idleTimeoutMs) return void this.sock.destroy();
				if (this.readyState === 1 && !this.sock.destroyed)
					this.sock.write(encodeFrame(0x9, Buffer.alloc(0)));
			},
			Math.max(250, Math.floor(idleTimeoutMs / 2)),
		);
		this.keepalive.unref();
	}

	private hold(delta: number): void {
		this.held += delta;
		totalBuffered += delta;
	}

	/** Bytes that arrived with the upgrade request, then every later chunk. */
	onData(chunk: Buffer): void {
		if (this.readyState === 3 || this.dead) return;
		this.lastSeen = Date.now();
		this.chunks.push(chunk);
		this.chunksLen += chunk.length;
		this.hold(chunk.length);
		if (totalBuffered > MAX_WS_TOTAL_BUFFERED) return void this.fail(1013);
		this.pump();
	}

	private pump(): void {
		while (!this.dead && this.readyState !== 3 && this.chunksLen >= Math.max(2, this.need)) {
			// One join per frame: header bytes first, then the whole frame once it has all arrived.
			let buf = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks);
			this.chunks = [buf];
			const size = frameSize(buf);
			if (size === "need-more") {
				this.need = 0;
				return;
			}
			if (size === "protocol") return void this.fail(1002);
			if (size === "too-big") return void this.fail(1009);
			if (buf.length < size) {
				this.need = size;
				return;
			}
			const r = decodeFrame(buf);
			if (typeof r === "string") return void this.fail(r === "too-big" ? 1009 : 1002);
			buf = buf.subarray(r.used);
			this.hold(-r.used);
			this.chunks = buf.length ? [buf] : [];
			this.chunksLen = buf.length;
			this.need = 0;
			if (!this.onFrame(r.frame) || this.readyState === 3) return;
		}
	}

	private onFrame(f: Frame): boolean {
		// After our own close frame only the peer's close matters; its other frames are dropped.
		if (this.readyState === 2 && f.opcode !== 0x8) return true;
		switch (f.opcode) {
			case 0x8: {
				if (f.payload.length === 1) return this.fail(1002);
				const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
				if (f.payload.length >= 2 && !validClientCloseCode(code)) return this.fail(1002);
				const reason = f.payload.length > 2 ? decodeUtf8(f.payload.subarray(2)) : "";
				if (reason === null) return this.fail(1007);
				if (!this.closeSent) this.writeClose(code === 1005 ? 1000 : code, "");
				this.sock.end();
				this.finish(code, reason);
				return false;
			}
			case 0x9:
				this.sock.write(encodeFrame(0xa, f.payload));
				return true;
			case 0xa:
				return true;
			case 0x1:
			case 0x2:
			case 0x0: {
				if (f.opcode !== 0) {
					if (this.parts.length) return this.fail(1002); // new message mid-fragment
					this.partsOpcode = f.opcode;
				} else if (!this.parts.length) {
					return this.fail(1002); // continuation with nothing to continue
				}
				this.parts.push(f.payload);
				this.partsLen += f.payload.length;
				this.hold(f.payload.length);
				if (this.partsLen > MAX_WS_MESSAGE || this.parts.length > MAX_WS_FRAGMENTS)
					return this.fail(1009);
				if (!f.fin) return true;
				const whole =
					this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts);
				const opcode = this.partsOpcode;
				this.hold(-this.partsLen);
				this.parts = [];
				this.partsLen = 0;
				let message: string | Buffer = whole;
				if (opcode === 0x1) {
					const text = decodeUtf8(whole);
					if (text === null) return this.fail(1007);
					message = text;
				}
				try {
					this.handlers.message?.(this, message);
				} catch (err) {
					console.error("[serve] websocket message handler threw:", err);
				}
				return true;
			}
			default:
				return this.fail(1002);
		}
	}

	send(data: string | Uint8Array | ArrayBuffer): number {
		if (this.readyState !== 1) return 0;
		// A peer that does not read cannot make this process queue without limit.
		if (this.sock.writableLength > MAX_WS_BACKLOG) {
			this.close(1013, "backpressure");
			return 0;
		}
		const isText = typeof data === "string";
		const payload = isText
			? Buffer.from(data, "utf8")
			: data instanceof ArrayBuffer
				? Buffer.from(data)
				: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		this.sock.write(encodeFrame(isText ? 0x1 : 0x2, payload));
		return payload.length;
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState !== 1) return;
		this.readyState = 2;
		this.writeClose(code, reason);
		// A well-behaved peer answers with its own close; do not wait for one that will not.
		setTimeout(() => this.sock.destroy(), 2000).unref();
	}

	private writeClose(code: number, reason: string): void {
		this.closeSent = true;
		const r = Buffer.from(reason, "utf8").subarray(0, 123);
		const p = Buffer.alloc(2 + r.length);
		p.writeUInt16BE(code, 0);
		r.copy(p, 2);
		if (!this.sock.destroyed) this.sock.write(encodeFrame(0x8, p));
	}

	/** Close with `code`, stop reading, and hang up. Returns false so a frame handler can `return this.fail(..)`. */
	private fail(code: number): false {
		this.dead = true;
		this.chunks = [];
		this.chunksLen = 0;
		this.parts = [];
		this.partsLen = 0;
		this.hold(-this.held);
		this.close(code);
		this.sock.end();
		return false;
	}

	private finish(code: number, reason: string): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		clearInterval(this.keepalive);
		this.chunks = [];
		this.parts = [];
		this.hold(-this.held);
		try {
			this.handlers.close?.(this, code, reason);
		} catch (err) {
			console.error("[serve] websocket close handler threw:", err);
		}
	}
}

// ── http ─────────────────────────────────────────────────────────────────

function toRequest(req: IncomingMessage, upgrade: boolean): Request {
	const host = req.headers.host ?? "localhost";
	const headers = new Headers();
	for (let i = 0; i < req.rawHeaders.length; i += 2) {
		try {
			headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
		} catch {
			// a header name or value the Fetch API refuses is dropped, as Bun does
		}
	}
	const method = req.method ?? "GET";
	const hasBody = !upgrade && method !== "GET" && method !== "HEAD";
	return new Request(`http://${host}${req.url ?? "/"}`, {
		method,
		headers,
		...(hasBody
			? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" as const }
			: {}),
	});
}

async function writeResponse(res: ServerResponse, out: Response, head: boolean): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	out.headers.forEach((v, k) => {
		if (k !== "set-cookie") headers[k] = v;
	});
	const cookies = out.headers.getSetCookie();
	if (cookies.length) headers["set-cookie"] = cookies;
	res.writeHead(out.status, out.statusText || undefined, headers);
	if (!out.body || head) return void res.end();
	const reader = out.body.getReader();
	res.on("close", () => void reader.cancel().catch(() => {}));
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!res.write(value)) await new Promise<void>((r) => res.once("drain", r));
			if (res.destroyed) return;
		}
	} catch {
		// the source stream died mid-body: end what we have
	}
	res.end();
}

export function serve(opts: ServeOptions): NodeServer {
	const peers = new WeakMap<Request, Socket>();
	const upgrades = new WeakMap<Request, { data: Loose } | null>();
	const server: HttpServer = createServer();
	let boundPort = opts.port ?? 0;
	const hostname = opts.hostname ?? "0.0.0.0";

	const api: NodeServer = {
		get port() {
			return boundPort;
		},
		hostname,
		upgrade(req, o) {
			if (!upgrades.has(req) || upgrades.get(req)) return false;
			upgrades.set(req, { data: o?.data });
			return true;
		},
		requestIP(req) {
			const s = peers.get(req);
			if (!s?.remoteAddress) return null;
			return {
				address: s.remoteAddress,
				family: s.remoteFamily ?? "IPv4",
				port: s.remotePort ?? 0,
			};
		},
		stop(closeActive) {
			server.close();
			if (closeActive) server.closeAllConnections();
		},
	};

	const run = async (
		req: IncomingMessage,
		isUpgrade: boolean,
	): Promise<{ request: Request | null; out: Response | undefined }> => {
		let request: Request;
		try {
			request = toRequest(req, isUpgrade);
		} catch {
			// A Host header or request target the Fetch API refuses (a space, userinfo, a bad
			// port): a 400, never an exception out of the event handler (that would end the process).
			return { request: null, out: new Response("Bad Request", { status: 400 }) };
		}
		peers.set(request, req.socket);
		if (isUpgrade) upgrades.set(request, null);
		try {
			return { request, out: await opts.fetch(request, api) };
		} catch (err) {
			console.error("[serve] fetch handler threw:", err);
			return { request, out: new Response("Internal Server Error", { status: 500 }) };
		}
	};

	server.on("request", async (req, res) => {
		try {
			const { out } = await run(req, false);
			await writeResponse(
				res,
				out ?? new Response("Not Found", { status: 404 }),
				req.method === "HEAD",
			);
		} catch (err) {
			// A response the handler built that Node refuses to write (a bad header value, say).
			console.error("[serve] writing a response failed:", err);
			if (res.headersSent || res.destroyed) res.destroy();
			else {
				res.statusCode = 500;
				res.end("Internal Server Error");
			}
		}
	});

	server.on("upgrade", async (req: IncomingMessage, sock: Duplex, head: Buffer) => {
		sock.on("error", () => sock.destroy());
		try {
			await onUpgrade(req, sock, head);
		} catch (err) {
			console.error("[serve] upgrade failed:", err);
			sock.destroy();
		}
	});

	const onUpgrade = async (req: IncomingMessage, sock: Duplex, head: Buffer) => {
		{
			const { request, out } = await run(req, true);
			const accepted = request ? upgrades.get(request) : null;
			const key = req.headers["sec-websocket-key"];
			const isWs =
				String(req.headers.upgrade ?? "").toLowerCase() === "websocket" &&
				req.headers["sec-websocket-version"] === "13" &&
				typeof key === "string";
			if (out === undefined && accepted && isWs) {
				const accept = createHash("sha1")
					.update(key + WS_GUID)
					.digest("base64");
				sock.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
				);
				const ws = new ServerWebSocket(
					sock,
					accepted.data,
					req.socket.remoteAddress ?? "",
					opts.websocket ?? {},
					(opts.websocket?.idleTimeout ?? DEFAULT_WS_IDLE_SECONDS) * 1000,
				);
				try {
					opts.websocket?.open?.(ws);
				} catch (err) {
					console.error("[serve] websocket open handler threw:", err);
				}
				if (head.length) ws.onData(head);
				return;
			}
			// Refused, or not a valid WebSocket handshake: answer it as plain HTTP and hang up.
			const res = new ServerResponse(req);
			res.assignSocket(sock as Socket);
			res.on("finish", () => sock.destroy());
			await writeResponse(
				res,
				out ??
					new Response(isWs ? "WebSocket upgrade required" : "Bad WebSocket handshake", {
						status: isWs ? 426 : 400,
					}),
				false,
			);
		}
	};

	// Bind synchronously from the caller's view, as Bun.serve does: a taken port or a bad
	// address surfaces as an error on the event loop, not a silently dead server.
	server.maxConnections = MAX_CONNECTIONS;
	server.on("error", (err) => {
		// Only a failed bind ends the process. An accept error later (out of file descriptors)
		// is logged and survived: a flood of connections must not be a way to stop the daemon.
		if (!server.listening) {
			console.error("[serve] listen failed:", (err as Error).message);
			process.exit(1);
		}
		console.error("[serve] server error:", (err as Error).message);
	});
	server.listen(opts.port ?? 0, hostname);
	const addr = server.address() as AddressInfo | null;
	if (addr) boundPort = addr.port;
	else server.once("listening", () => void (boundPort = (server.address() as AddressInfo).port));
	return api;
}
