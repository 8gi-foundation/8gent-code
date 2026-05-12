/**
 * `/store` WebSocket route: JSON-RPC 2.0 over WS for session, kg, and fs.
 *
 * Auth: capability token. The daemon reads (or generates) a 32-byte hex token
 * at `~/.8gent/server.token`. Clients send a `handshake` frame as the first
 * message containing the token plus an initiator string. Until the handshake
 * succeeds, every JSON-RPC call returns `-32000 unauthorized`.
 *
 * After handshake, callers can dispatch session.*, kg.*, and fs.* methods.
 * Notifications (server -> client) are sent for `session.subscribe`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { getDataDir } from "../../data-dir";
import { fsDelete, fsEdit, fsExec, fsList, fsRead, fsStat, fsWrite } from "./fs";
import {
	JSONRPC_PARSE_ERROR,
	JSONRPC_UNAUTHORIZED,
	type JsonRpcContext,
	type JsonRpcHandler,
	type JsonRpcRequest,
	dispatch,
	makeError,
	makeNotification,
	parseRequestFromObject,
} from "./jsonrpc";
import { kgAdd, kgDelete, kgInspect, kgSearch, kgStatus } from "./kg";
import {
	sessionList,
	sessionMessages,
	sessionOpen,
	sessionSubscribe,
	tearDownSessionSubs,
} from "./session";

// ── Capability token ──────────────────────────────────────────────────

let _cachedToken: string | null = null;

export function ensureServerToken(tokenPath?: string): string {
	if (_cachedToken && !tokenPath) return _cachedToken;
	const file = tokenPath ?? path.join(getDataDir(), "server.token");
	const dir = path.dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	if (existsSync(file)) {
		const t = readFileSync(file, "utf-8").trim();
		if (t.length >= 32) {
			if (!tokenPath) _cachedToken = t;
			return t;
		}
	}
	const fresh = crypto.randomBytes(32).toString("hex");
	writeFileSync(file, fresh, { mode: 0o600 });
	if (!tokenPath) _cachedToken = fresh;
	return fresh;
}

// ── WebSocket type and state ──────────────────────────────────────────

export interface StoreWS {
	send(data: string | ArrayBufferView | ArrayBuffer): number | -1 | undefined;
	close(code?: number, reason?: string): void;
}

interface StoreRouteState {
	id: string;
	authenticated: boolean;
	initiator: string;
	socketKey: object;
	/**
	 * Per-socket message queue. Bun's `message()` callback can re-enter while
	 * a prior `await` is suspended, which (without serialisation) lets a
	 * client send `[handshake, fs.exec]` back-to-back and have `fs.exec` slip
	 * through before `authenticated = true` is committed. We chain every
	 * incoming message onto this promise so they execute strictly in order.
	 */
	queue: Promise<void>;
}

const stateBySocket = new WeakMap<StoreWS, StoreRouteState>();
let nextClientId = 0;

// ── Handler table ─────────────────────────────────────────────────────

const HANDLERS: Record<string, JsonRpcHandler> = {
	"session.list": sessionList,
	"session.open": sessionOpen,
	"session.messages": sessionMessages,
	"session.subscribe": sessionSubscribe,
	"kg.add": kgAdd,
	"kg.search": kgSearch,
	"kg.inspect": kgInspect,
	"kg.delete": kgDelete,
	"kg.status": kgStatus,
	"fs.list": fsList,
	"fs.read": fsRead,
	"fs.write": fsWrite,
	"fs.edit": fsEdit,
	"fs.delete": fsDelete,
	"fs.stat": fsStat,
	"fs.exec": fsExec,
};

// ── Lifecycle ─────────────────────────────────────────────────────────

export function handleStoreOpen(ws: StoreWS): void {
	const id = `s_${nextClientId++}`;
	const socketKey = {};
	const state: StoreRouteState = {
		id,
		authenticated: false,
		initiator: "anonymous",
		socketKey,
		queue: Promise.resolve(),
	};
	stateBySocket.set(ws, state);
	console.log(`[store-route] client ${id} connected`);
}

export function handleStoreClose(ws: StoreWS): void {
	const state = stateBySocket.get(ws);
	if (state) {
		tearDownSessionSubs(state.socketKey);
		console.log(`[store-route] client ${state.id} disconnected`);
	}
	stateBySocket.delete(ws);
}

function send(ws: StoreWS, msg: object): void {
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		// Client gone.
	}
}

interface HandshakeMsg {
	type: "handshake";
	token: string;
	initiator?: string;
}

function isHandshake(value: unknown): value is HandshakeMsg {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "handshake" &&
		typeof (value as { token?: unknown }).token === "string"
	);
}

export function handleStoreMessage(
	ws: StoreWS,
	raw: string,
	options: { tokenPath?: string } = {},
): Promise<void> {
	const state = stateBySocket.get(ws);
	if (!state) return Promise.resolve();

	// Chain onto the per-socket queue so concurrent messages execute strictly
	// in arrival order. This is what stops a client from racing handshake
	// against an authenticated call: the second message awaits the first.
	const next = state.queue.then(() =>
		handleMessageInner(ws, state, raw, options).catch((err) => {
			console.warn(`[store-route] handler error for ${state.id}:`, (err as Error).message);
		}),
	);
	state.queue = next;
	return next;
}

async function handleMessageInner(
	ws: StoreWS,
	state: StoreRouteState,
	raw: string,
	options: { tokenPath?: string },
): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		send(ws, makeError(null, JSONRPC_PARSE_ERROR, "parse error"));
		return;
	}

	// Handshake handling (out-of-band, not JSON-RPC).
	if (isHandshake(parsed)) {
		const expected = ensureServerToken(options.tokenPath);
		const provided = parsed.token;
		// constant-time compare to keep timing attacks out of the hot path
		if (
			provided.length === expected.length &&
			crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
		) {
			state.authenticated = true;
			state.initiator = parsed.initiator ?? "anonymous";
			send(ws, { type: "handshake.ok", route: "store" });
		} else {
			send(ws, { type: "handshake.fail", reason: "invalid token" });
			try {
				ws.close(4401, "unauthorized");
			} catch {}
		}
		return;
	}

	// Reuse the already-parsed object instead of re-parsing the raw frame.
	const reqOrErr = parseRequestFromObject(parsed);
	if ("error" in reqOrErr) {
		send(ws, reqOrErr);
		return;
	}
	const req = reqOrErr as JsonRpcRequest;

	if (!state.authenticated) {
		send(ws, makeError(req.id ?? null, JSONRPC_UNAUTHORIZED, "unauthorized"));
		return;
	}

	const ctx: JsonRpcContext = {
		socketKey: state.socketKey,
		initiator: state.initiator,
		notify: (method, params) => send(ws, makeNotification(method, params)),
	};
	const response = await dispatch(HANDLERS, req, ctx);
	if (response) send(ws, response);
}

// Test hook
export function _resetStoreRoute(): void {
	_cachedToken = null;
}
