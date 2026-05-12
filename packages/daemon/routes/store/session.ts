/**
 * session.* JSON-RPC handlers.
 *
 * Thin shim over `packages/eight/session-manager.ts`. The session manager
 * already persists sessions as `~/.8gent/sessions/{id}.json` with messages
 * inline; we expose list/open/messages and a notification stream.
 *
 * Notifications: when a new message is appended (via the bus event
 * `agent:stream` reaching `final=true`, or when the agent emits an
 * `agent:error`), subscribers to `session.subscribe({ id })` receive a
 * `session.message` notification. This is a polling-free way for the TUI
 * and the Electron app to mirror the same conversation in real time.
 */

import { type EventName, bus } from "../../events";
import {
	type SessionInfo,
	SessionManager,
} from "../../../eight/session-manager";
import {
	JSONRPC_BLOCKED,
	JsonRpcError,
	type JsonRpcContext,
	type JsonRpcHandler,
	type NotifySender,
} from "./jsonrpc";

/** Max session subscriptions a single socket may hold open at once. */
export const MAX_SESSION_SUBS_PER_SOCKET = 32;

let _manager: SessionManager | null = null;
function manager(): SessionManager {
	if (!_manager) _manager = new SessionManager();
	return _manager;
}

interface SessionListParams {
	limit?: number;
	cursor?: string | null;
}

interface SessionOpenParams {
	id: string;
}

interface SessionMessagesParams {
	id: string;
	limit?: number;
	before?: number; // index, exclusive
}

interface SessionSubscribeParams {
	id: string;
}

interface ExposedSession {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	channel: string;
	lastMessagePreview: string;
}

function previewOf(messages: Array<{ role: string; content: string }>): string {
	if (!messages.length) return "";
	const last = messages[messages.length - 1];
	const text = typeof last.content === "string" ? last.content : "";
	return text.slice(0, 140).replace(/\s+/g, " ").trim();
}

function expose(info: SessionInfo, preview: string): ExposedSession {
	return {
		id: info.id,
		title: info.name || info.id,
		createdAt: info.createdAt,
		updatedAt: info.lastActiveAt,
		// SessionInfo doesn't carry a channel today; we surface the persistent
		// store's notion of "where it lives" as 'session-store' until the
		// session manager grows a channel field. The agent-pool exposes
		// channels for in-flight sessions only.
		channel: "session-store",
		lastMessagePreview: preview,
	};
}

// ── Subscriptions ─────────────────────────────────────────────────────

interface ActiveSub {
	sessionId: string;
	notify: NotifySender;
	busSubs: number[];
}

const subscriptionsBySocket = new WeakMap<object, Map<string, ActiveSub>>();

function subKey(sessionId: string): string {
	return `session:${sessionId}`;
}

export function tearDownSessionSubs(socketKey: object): void {
	const subs = subscriptionsBySocket.get(socketKey);
	if (!subs) return;
	for (const sub of subs.values()) {
		for (const id of sub.busSubs) bus.off(id);
	}
	subscriptionsBySocket.delete(socketKey);
}

// ── Handlers ──────────────────────────────────────────────────────────

export const sessionList: JsonRpcHandler = (raw, _ctx) => {
	const params = (raw ?? {}) as SessionListParams;
	const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
	// Cursor is `id` of last item from the previous page; when present we
	// page by lastActiveAt strictly older than that record.
	const all = manager().list(1000); // already sorted desc
	let start = 0;
	if (params.cursor) {
		const idx = all.findIndex((s) => s.id === params.cursor);
		start = idx >= 0 ? idx + 1 : 0;
	}
	const slice = all.slice(start, start + limit);
	const sessions = slice.map((info) => {
		const file = manager().resume(info.id);
		const preview = file ? previewOf(file.messages) : "";
		return expose(info, preview);
	});
	const nextCursor = slice.length === limit ? slice[slice.length - 1]?.id ?? null : null;
	return { sessions, nextCursor };
};

export const sessionOpen: JsonRpcHandler = (raw, _ctx) => {
	const params = raw as SessionOpenParams;
	if (!params?.id) throw new Error("session.open: missing id");
	const file = manager().resume(params.id);
	if (!file) throw new Error(`session.open: not found: ${params.id}`);
	const { messages, ...info } = file;
	return {
		id: info.id,
		title: info.name || info.id,
		messages,
		metadata: {
			model: info.model,
			provider: info.provider,
			cwd: info.cwd,
			branch: info.branch ?? null,
			messageCount: info.messageCount,
			createdAt: info.createdAt,
			updatedAt: info.lastActiveAt,
		},
	};
};

export const sessionMessages: JsonRpcHandler = (raw, _ctx) => {
	const params = raw as SessionMessagesParams;
	if (!params?.id) throw new Error("session.messages: missing id");
	const file = manager().resume(params.id);
	if (!file) throw new Error(`session.messages: not found: ${params.id}`);
	const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
	const before = params.before ?? file.messages.length;
	const start = Math.max(0, before - limit);
	return { messages: file.messages.slice(start, before) };
};

export const sessionSubscribe: JsonRpcHandler = (raw, ctx: JsonRpcContext) => {
	const params = raw as SessionSubscribeParams;
	if (!params?.id) throw new Error("session.subscribe: missing id");
	const sessionId = params.id;

	// Verify the session exists; subscribers shouldn't be able to listen
	// to arbitrary IDs to discover whether they exist.
	const file = manager().resume(sessionId);
	if (!file) throw new Error(`session.subscribe: not found: ${sessionId}`);

	const socketKey = ctx.socketKey;
	let subs = subscriptionsBySocket.get(socketKey);
	if (!subs) {
		subs = new Map();
		subscriptionsBySocket.set(socketKey, subs);
	}
	const key = subKey(sessionId);
	if (subs.has(key)) {
		// Already subscribed; idempotent ack.
		return { subscribed: true, sessionId, alreadyActive: true };
	}
	// Cap subscriptions per socket. Without this, a misbehaving client could
	// subscribe to thousands of session IDs and leak bus listeners.
	if (subs.size >= MAX_SESSION_SUBS_PER_SOCKET) {
		throw new JsonRpcError(
			JSONRPC_BLOCKED,
			`session.subscribe: per-socket subscription cap reached (${MAX_SESSION_SUBS_PER_SOCKET})`,
			{ blocked: true, cap: MAX_SESSION_SUBS_PER_SOCKET },
		);
	}

	const events: EventName[] = ["agent:stream", "agent:error", "session:end"];
	const busSubs: number[] = [];
	for (const ev of events) {
		const id = bus.on(ev, (payload: any) => {
			if (payload?.sessionId !== sessionId) return;
			ctx.notify("session.message", { sessionId, kind: ev, payload });
		});
		busSubs.push(id);
	}
	subs.set(key, { sessionId, notify: ctx.notify, busSubs });

	return { subscribed: true, sessionId, alreadyActive: false };
};

/** Reset for tests. */
export function _resetSessionState(): void {
	_manager = null;
}
