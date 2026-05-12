/**
 * Minimal JSON-RPC 2.0 dispatcher for the `/store` route.
 *
 * The daemon's other routes use bespoke envelopes; this route is new and
 * cross-process by design (TUI, Electron, future hosts), so we adopt the
 * standard wire format. Single-request only - no batches in v0.
 *
 * Wire shape:
 *   request:  { jsonrpc: "2.0", id, method, params }
 *   response: { jsonrpc: "2.0", id, result }   on success
 *             { jsonrpc: "2.0", id, error: { code, message, data? } } on error
 *   notify:   { jsonrpc: "2.0", method, params }   server -> client, no id
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params: unknown;
}

export type NotifySender = (method: string, params: unknown) => void;

/** Per-request context handed to every handler. */
export interface JsonRpcContext {
	/** Stable opaque key identifying the socket (for subscription bookkeeping). */
	socketKey: object;
	/** Send a server-initiated notification on this socket. */
	notify: NotifySender;
	/** Caller initiator string, set after handshake (used in audit logs). */
	initiator: string;
}

export type JsonRpcHandler = (params: unknown, ctx: JsonRpcContext) => unknown | Promise<unknown>;

// JSON-RPC 2.0 error codes
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
// Application-level codes
export const JSONRPC_UNAUTHORIZED = -32000;
export const JSONRPC_BLOCKED = -32001;

export class JsonRpcError extends Error {
	constructor(
		public code: number,
		message: string,
		public data?: unknown,
	) {
		super(message);
	}
}

export function makeError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}

export function makeResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

export function makeNotification(method: string, params: unknown): JsonRpcNotification {
	return { jsonrpc: "2.0", method, params };
}

/** Run a handler and turn thrown errors into JSON-RPC error responses. */
export async function dispatch(
	handlers: Record<string, JsonRpcHandler>,
	req: JsonRpcRequest,
	ctx: JsonRpcContext,
): Promise<JsonRpcResponse | null> {
	if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
		return makeError(req.id ?? null, JSONRPC_INVALID_REQUEST, "invalid JSON-RPC request");
	}

	const handler = handlers[req.method];
	if (!handler) {
		return makeError(req.id ?? null, JSONRPC_METHOD_NOT_FOUND, `unknown method: ${req.method}`);
	}

	// Notification (no id) - run for side effects, return nothing.
	const isNotification = req.id === undefined || req.id === null;

	try {
		const result = await handler(req.params ?? {}, ctx);
		if (isNotification) return null;
		return makeResult(req.id ?? null, result);
	} catch (err) {
		if (isNotification) return null;
		if (err instanceof JsonRpcError) {
			return makeError(req.id ?? null, err.code, err.message, err.data);
		}
		const msg = err instanceof Error ? err.message : String(err);
		return makeError(req.id ?? null, JSONRPC_INTERNAL_ERROR, msg);
	}
}

/** Parse a raw text frame; returns either the parsed request or an error response. */
export function parseRequest(raw: string): JsonRpcRequest | JsonRpcResponse {
	try {
		const obj = JSON.parse(raw) as unknown;
		return parseRequestFromObject(obj);
	} catch {
		return makeError(null, JSONRPC_PARSE_ERROR, "parse error");
	}
}

/**
 * Same as `parseRequest` but accepts an already-parsed object. Used by the
 * route to avoid re-parsing the frame after the handshake check.
 */
export function parseRequestFromObject(obj: unknown): JsonRpcRequest | JsonRpcResponse {
	if (
		obj &&
		typeof obj === "object" &&
		(obj as { jsonrpc?: unknown }).jsonrpc === "2.0"
	) {
		return obj as JsonRpcRequest;
	}
	return makeError(null, JSONRPC_INVALID_REQUEST, "not a JSON-RPC 2.0 request");
}
