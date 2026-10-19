import * as readline from "node:readline";
/**
 * 8gent Code - JSON-RPC 2.0 Server
 * Headless mode for CI/IDE integration. Newline-delimited JSON on stdin/stdout.
 * Spawn with: 8gent rpc | 8gent --rpc
 */
import {
	BusyError,
	createSession,
	type Session,
	type SessionEvent,
	UnsupportedError,
} from "./sdk";
import { listSessions } from "./session-store";
import type { RPCNotification, RPCRequest, RPCResponse } from "./rpc-types";
import { RPC_ERRORS } from "./rpc-types";
import { TOOL_CATEGORIES } from "./tool-registry";

const sessions = new Map<string, Session>();

function send(msg: RPCResponse | RPCNotification): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function sendResult(id: number | string, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}
function sendError(id: number | string, code: number, message: string, data?: unknown): void {
	send({ jsonrpc: "2.0", id, error: { code, message, data } });
}
function notify(method: string, params: Record<string, unknown>): void {
	send({ jsonrpc: "2.0", method, params });
}

/** Map an SDK session event to the stream.* notification a client reads. */
function forward(sessionId: string, e: SessionEvent): void {
	switch (e.type) {
		case "tool_start":
			return notify("stream.toolCall", { sessionId, tool: e.tool, args: e.args });
		case "tool_end":
			return notify("stream.toolResult", { sessionId, tool: e.tool, result: e.result });
		case "text":
			return notify("stream.token", { sessionId, token: e.text });
		case "steer":
			return notify("stream.steer", { sessionId, text: e.text });
		case "follow_up":
			return notify("stream.followUp", { sessionId, text: e.text });
		case "done":
			return notify("stream.done", { sessionId });
		case "error":
			return notify("stream.error", { sessionId, error: e.error });
	}
}

function register(session: Session): void {
	sessions.set(session.id, session);
	session.subscribe((e) => forward(session.id, e));
}

// ── Method dispatch ───────────────────────────────────────────────

type Handler = (id: number | string, params: Record<string, unknown>) => Promise<void>;

/** Look up params.sessionId. Sends INVALID_PARAMS and returns null when it is missing or unknown. */
function need(id: number | string, params: Record<string, unknown>): Session | null {
	const sessionId = params.sessionId as string;
	const session = sessionId ? sessions.get(sessionId) : undefined;
	if (!session) {
		sendError(id, RPC_ERRORS.INVALID_PARAMS, `Unknown session: ${sessionId}`);
		return null;
	}
	return session;
}

/** Turn an SDK error into the right JSON-RPC error. */
function fail(id: number | string, err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err);
	if (err instanceof BusyError) return sendError(id, RPC_ERRORS.BUSY, msg);
	if (err instanceof UnsupportedError) return sendError(id, RPC_ERRORS.UNSUPPORTED, msg);
	if (err instanceof RangeError) return sendError(id, RPC_ERRORS.INVALID_PARAMS, msg);
	sendError(id, RPC_ERRORS.INTERNAL_ERROR, msg);
}

const methods: Record<string, Handler> = {
	"session.create": async (id, params) => {
		const session = createSession({
			model: params.model as string | undefined,
			runtime: params.runtime as string | undefined,
			cwd: params.cwd as string | undefined,
			systemPrompt: params.systemPrompt as string | undefined,
			persist: params.persist === false ? false : undefined,
		});
		register(session);
		sendResult(id, { sessionId: session.id });
	},

	"session.message": async (id, params) => {
		const sessionId = params.sessionId as string;
		const content = params.content as string;

		if (!sessionId || !content) {
			return sendError(id, RPC_ERRORS.INVALID_PARAMS, "sessionId and content required");
		}
		const session = need(id, params);
		if (!session) return;

		try {
			const response = await session.turn(content);
			sendResult(id, { response, usage: {} });
		} catch (err) {
			fail(id, err);
		}
	},

	"session.abort": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		session.abort();
		sendResult(id, { ok: true });
	},

	"session.destroy": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		await session.dispose();
		sessions.delete(session.id);
		sendResult(id, { ok: true });
	},

	"tools.list": async (id) => {
		const tools = Object.entries(TOOL_CATEGORIES).flatMap(([category, names]) =>
			names.map((name) => ({ name, category })),
		);
		sendResult(id, { tools });
	},

	// ── Added for #3918 (N3): drive a running session from a script ──

	/** Like session.message, then runs queued follow-ups and late steers. Result: the final text. */
	"session.prompt": async (id, params) => {
		const content = params.content as string;
		if (!params.sessionId || !content) {
			return sendError(id, RPC_ERRORS.INVALID_PARAMS, "sessionId and content required");
		}
		const session = need(id, params);
		if (!session) return;
		try {
			sendResult(id, { response: await session.prompt(content), usage: {} });
		} catch (err) {
			fail(id, err);
		}
	},

	"session.steer": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		const text = params.content as string;
		if (typeof text !== "string" || !text.trim()) {
			return sendError(id, RPC_ERRORS.INVALID_PARAMS, "content required");
		}
		const queued = session.steer(text);
		const state = session.getState();
		sendResult(id, { queued, busy: state.busy, queueLength: state.queueLength });
	},

	"session.followUp": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		const text = params.content as string;
		if (typeof text !== "string" || !text.trim()) {
			return sendError(id, RPC_ERRORS.INVALID_PARAMS, "content required");
		}
		const queued = session.followUp(text);
		const state = session.getState();
		sendResult(id, { queued, busy: state.busy, queueLength: state.queueLength });
	},

	"session.clearQueue": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		sendResult(id, session.clearQueue());
	},

	"session.getState": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		sendResult(id, session.getState());
	},

	"session.setModel": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		const model = params.model as string;
		if (typeof model !== "string" || !model) {
			return sendError(id, RPC_ERRORS.INVALID_PARAMS, "model required");
		}
		try {
			sendResult(id, session.setModel(model));
		} catch (err) {
			fail(id, err);
		}
	},

	"session.compact": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		try {
			session.compact();
		} catch (err) {
			fail(id, err);
		}
	},

	"session.getMessages": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		sendResult(id, { messages: session.getMessages() });
	},

	"session.getLastAssistantText": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		sendResult(id, { text: session.getLastAssistantText() });
	},

	/** Stored sessions, newest first. Params: cwd?, limit?. Reads the session store, live or not. */
	"session.list": async (id, params) => {
		const limit = typeof params.limit === "number" ? params.limit : undefined;
		const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
		sendResult(id, { sessions: listSessions({ cwd, limit }) });
	},

	/** Copy a live session's stored conversation into a new live session. Params: sessionId, entryId?, name?. */
	"session.fork": async (id, params) => {
		const session = need(id, params);
		if (!session) return;
		try {
			const child = session.fork({
				entryId: params.entryId as string | null | undefined,
				name: params.name as string | undefined,
			});
			register(child);
			sendResult(id, {
				sessionId: child.id,
				parentSessionId: session.id,
				messageCount: child.getMessages().length,
			});
		} catch (err) {
			fail(id, err);
		}
	},
};

// ── Request handler ───────────────────────────────────────────────

async function handleLine(line: string): Promise<void> {
	let parsed: RPCRequest;
	try {
		parsed = JSON.parse(line);
	} catch {
		return sendError(0, RPC_ERRORS.PARSE_ERROR, "Invalid JSON");
	}

	if (parsed.jsonrpc !== "2.0" || !parsed.method || parsed.id == null) {
		return sendError(parsed.id ?? 0, RPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC 2.0 request");
	}

	const handler = methods[parsed.method];
	if (!handler) {
		return sendError(parsed.id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${parsed.method}`);
	}

	try {
		await handler(parsed.id, parsed.params || {});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		sendError(parsed.id, RPC_ERRORS.INTERNAL_ERROR, msg);
	}
}

// ── Main loop ─────────────────────────────────────────────────────

export async function startRPCServer(): Promise<void> {
	// Redirect console to stderr so stdout stays clean for JSON-RPC
	const stderrWrite = (data: string) => process.stderr.write(`${data}\n`);
	console.log = stderrWrite;
	console.info = stderrWrite;
	console.warn = stderrWrite;
	console.debug = stderrWrite;
	// Keep console.error on stderr (already there)

	process.stderr.write("[8gent-rpc] Server ready. Waiting for JSON-RPC requests on stdin.\n");

	const rl = readline.createInterface({
		input: process.stdin,
		terminal: false,
	});

	rl.on("line", (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		handleLine(trimmed).catch((err) => {
			process.stderr.write(`[8gent-rpc] Unhandled error: ${err}\n`);
		});
	});

	rl.on("close", async () => {
		// Clean up all sessions on stdin close
		const ids = Array.from(sessions.keys());
		for (const sid of ids) {
			await sessions
				.get(sid)
				?.dispose()
				.catch(() => {});
		}
		process.exit(0);
	});
}
