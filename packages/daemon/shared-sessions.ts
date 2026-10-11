/**
 * Shared sessions (#3929): one session model for the TUI, the 8gent Browser
 * panel and any other loopback surface.
 *
 *   session:list    -> live shareable sessions + past ones from ~/.8gent/sessions
 *   session:attach  -> bind this connection to a live session, or restore a
 *                      past one into the pool first; replies with the transcript
 *   session:detach  -> unbind this connection; the session keeps running
 *   session:abort   -> stop the turn in flight; the session survives
 *
 * Pure protocol logic over narrow pool/store interfaces, like
 * timetravel-verbs.ts, so it is unit-testable without the gateway. gateway.ts
 * owns the side effects (binding, the loopback check, broadcasting).
 *
 * Only these channels are ever listed, attached or persisted. Telegram, table
 * (untrusted channel text), delegation and computer sessions stay private to
 * their own surface.
 */

import * as fs from "node:fs";
import { isSessionId } from "../eight/session-manager";

export const SHAREABLE_CHANNELS: ReadonlySet<string> = new Set([
	"tui",
	"os",
	"app",
	"api",
	"browser",
]);

/** Transcript frames stay small whatever the history size. */
export const TRANSCRIPT_MAX_MESSAGES = 200;
export const TRANSCRIPT_MAX_CHARS = 20_000;
/** Most messages written to the store per session. */
const PERSIST_MAX_MESSAGES = 1000;

export interface ChatMessage {
	role: string;
	content: string;
}

/** The slice of Agent this module needs. */
export interface SharedAgent {
	getMessageHistory(): Array<{ role: string; content: unknown }>;
	restoreFromCheckpoint(messages: ChatMessage[]): void;
	getModel?(): string;
	getRuntime?(): string;
	getWorkingDirectory?(): string;
}

/** The slice of AgentPool this module needs. */
export interface SharedPool {
	hasSession(sessionId: string): boolean;
	createSession(
		sessionId: string,
		channel: string,
		overrides?: { workingDirectory?: string },
	): void;
	getAgent(sessionId: string): SharedAgent | null;
	getSessionInfo(sessionId: string): {
		channel: string;
		messageCount: number;
		busy: boolean;
		createdAt: number;
		lastActiveAt: number;
	} | null;
	getActiveSessions(): Array<{ sessionId: string; channel: string }>;
	abort(sessionId: string): boolean;
}

export interface PastSessionFile {
	id: string;
	name?: string;
	channel?: string;
	model: string;
	provider: string;
	cwd: string;
	messageCount: number;
	lastActiveAt: string;
	messages: ChatMessage[];
}

/** The slice of SessionManager this module needs. */
export interface SharedStore {
	list(limit: number): Array<Omit<PastSessionFile, "messages">>;
	get(id: string): PastSessionFile | null;
	save(
		id: string,
		messages: ChatMessage[],
		meta: { channel?: string; model?: string; provider?: string; cwd?: string },
	): void;
}

export type SharedSessionInbound =
	| { type: "session:list"; past?: boolean; limit?: number }
	/** `channel` names the attaching surface (tui, browser, ...) for the user:message echo. */
	| { type: "session:attach"; sessionId: string; channel?: string }
	| { type: "session:detach" }
	| { type: "session:abort"; sessionId?: string };

export interface LiveSession {
	sessionId: string;
	channel: string;
	title?: string;
	busy: boolean;
	messageCount: number;
	clients: number;
	createdAt: number;
	lastActiveAt: number;
}

export interface PastSession {
	sessionId: string;
	channel: string;
	title: string;
	messageCount: number;
	model: string;
	cwd: string;
	lastActiveAt: number;
}

export type SharedSessionOutbound =
	| { type: "session:list"; live: LiveSession[]; past: PastSession[] }
	| {
			type: "session:attached";
			sessionId: string;
			channel: string;
			busy: boolean;
			restored: boolean;
			transcript: ChatMessage[];
			truncated: boolean;
	  }
	| { type: "session:detached"; sessionId: string | null }
	| { type: "session:aborted"; sessionId: string; aborted: boolean }
	| { type: "error"; message: string };

export const SHARED_SESSION_TYPES = [
	"session:list",
	"session:attach",
	"session:detach",
	"session:abort",
] as const;

export function isSharedSessionType(type: unknown): type is SharedSessionInbound["type"] {
	return typeof type === "string" && (SHARED_SESSION_TYPES as readonly string[]).includes(type);
}

export interface SharedSessionDeps {
	pool: SharedPool;
	store: SharedStore;
	/** The connection's bound session. */
	boundSessionId: string | null;
	/** How many connections are bound to a session. */
	clientsOn(sessionId: string): number;
}

export interface SharedSessionResult {
	reply: SharedSessionOutbound;
	/** Rebind the connection: a session id, null to unbind, undefined to leave as is. */
	bind?: string | null;
	/** The surface the connection declared on attach, when it is a shareable one. */
	surface?: string;
}

/** User and assistant turns with text content: what a person reads. */
export function chatMessages(history: Array<{ role: string; content: unknown }>): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of history) {
		if (
			(m.role === "user" || m.role === "assistant") &&
			typeof m.content === "string" &&
			m.content
		) {
			out.push({ role: m.role, content: m.content });
		}
	}
	return out;
}

/** The last TRANSCRIPT_MAX_MESSAGES messages, each capped at TRANSCRIPT_MAX_CHARS. */
export function capTranscript(messages: ChatMessage[]): {
	transcript: ChatMessage[];
	truncated: boolean;
} {
	let truncated = messages.length > TRANSCRIPT_MAX_MESSAGES;
	const transcript = messages.slice(-TRANSCRIPT_MAX_MESSAGES).map((m) => {
		if (m.content.length <= TRANSCRIPT_MAX_CHARS) return m;
		truncated = true;
		return { role: m.role, content: `${m.content.slice(0, TRANSCRIPT_MAX_CHARS)}\n[truncated]` };
	});
	return { transcript, truncated };
}

function isDirectory(p: unknown): p is string {
	if (typeof p !== "string" || !p) return false;
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function attachLive(sessionId: string, deps: SharedSessionDeps): SharedSessionResult {
	const info = deps.pool.getSessionInfo(sessionId);
	const agent = deps.pool.getAgent(sessionId);
	if (!info || !agent) return { reply: { type: "error", message: "session not found" } };
	if (!SHAREABLE_CHANNELS.has(info.channel)) {
		return { reply: { type: "error", message: "session cannot be shared" } };
	}
	return {
		bind: sessionId,
		reply: {
			type: "session:attached",
			sessionId,
			channel: info.channel,
			busy: info.busy,
			restored: false,
			...capTranscript(chatMessages(agent.getMessageHistory())),
		},
	};
}

function attachPast(sessionId: string, deps: SharedSessionDeps): SharedSessionResult {
	const past = deps.store.get(sessionId);
	if (!past) return { reply: { type: "error", message: "session not found" } };
	// A file with no channel was written by the TUI's own autosave.
	const channel = typeof past.channel === "string" ? past.channel : "tui";
	if (!SHAREABLE_CHANNELS.has(channel)) {
		return { reply: { type: "error", message: "session cannot be shared" } };
	}
	// The directory comes from the local file, never the wire, and must exist.
	const workingDirectory = isDirectory(past.cwd) ? past.cwd : undefined;
	deps.pool.createSession(sessionId, channel, workingDirectory ? { workingDirectory } : undefined);
	const agent = deps.pool.getAgent(sessionId);
	if (!agent) return { reply: { type: "error", message: "session could not be restored" } };
	const messages = chatMessages(Array.isArray(past.messages) ? past.messages : []);
	agent.restoreFromCheckpoint(messages);
	return {
		bind: sessionId,
		reply: {
			type: "session:attached",
			sessionId,
			channel,
			busy: false,
			restored: true,
			...capTranscript(messages),
		},
	};
}

function listSessions(
	msg: { past?: boolean; limit?: number },
	deps: SharedSessionDeps,
): SharedSessionResult {
	const limit = Number.isInteger(msg.limit) ? Math.min(100, Math.max(1, msg.limit as number)) : 20;
	const pastFiles = msg.past === false ? [] : deps.store.list(limit + 20);
	const titles = new Map(pastFiles.map((p) => [p.id, p.name]));
	const live: LiveSession[] = [];
	for (const s of deps.pool.getActiveSessions()) {
		if (!SHAREABLE_CHANNELS.has(s.channel)) continue;
		const info = deps.pool.getSessionInfo(s.sessionId);
		if (!info) continue;
		const title = titles.get(s.sessionId);
		live.push({
			sessionId: s.sessionId,
			channel: info.channel,
			...(title ? { title } : {}),
			busy: info.busy,
			messageCount: info.messageCount,
			clients: deps.clientsOn(s.sessionId),
			createdAt: info.createdAt,
			lastActiveAt: info.lastActiveAt,
		});
	}
	live.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	const liveIds = new Set(live.map((l) => l.sessionId));
	const past: PastSession[] = [];
	for (const p of pastFiles) {
		if (past.length >= limit) break;
		if (!isSessionId(p.id) || liveIds.has(p.id) || deps.pool.hasSession(p.id)) continue;
		const channel = typeof p.channel === "string" ? p.channel : "tui";
		if (!SHAREABLE_CHANNELS.has(channel)) continue;
		past.push({
			sessionId: p.id,
			channel,
			title: p.name || `Session ${String(p.lastActiveAt).slice(0, 10)}`,
			messageCount: p.messageCount,
			model: p.model,
			cwd: p.cwd,
			lastActiveAt: new Date(p.lastActiveAt).getTime() || 0,
		});
	}
	return { reply: { type: "session:list", live, past } };
}

/**
 * Handle one shared-session frame. Never throws: failures come back as an
 * `error` reply. The loopback and auth checks happen in the gateway first.
 */
export function handleSharedSession(
	msg: SharedSessionInbound,
	deps: SharedSessionDeps,
): SharedSessionResult {
	try {
		switch (msg.type) {
			case "session:list":
				return listSessions(msg, deps);

			case "session:attach": {
				if (!isSessionId(msg.sessionId)) {
					return { reply: { type: "error", message: "invalid session id" } };
				}
				const result = deps.pool.hasSession(msg.sessionId)
					? attachLive(msg.sessionId, deps)
					: attachPast(msg.sessionId, deps);
				if (result.bind && typeof msg.channel === "string" && SHAREABLE_CHANNELS.has(msg.channel)) {
					result.surface = msg.channel;
				}
				return result;
			}

			case "session:detach":
				return { bind: null, reply: { type: "session:detached", sessionId: deps.boundSessionId } };

			case "session:abort": {
				const sessionId = msg.sessionId ?? deps.boundSessionId;
				if (!isSessionId(sessionId)) {
					return { reply: { type: "error", message: "no session to stop" } };
				}
				const info = deps.pool.getSessionInfo(sessionId);
				if (!info) return { reply: { type: "error", message: "session not found" } };
				if (!SHAREABLE_CHANNELS.has(info.channel)) {
					return { reply: { type: "error", message: "session cannot be shared" } };
				}
				return {
					reply: { type: "session:aborted", sessionId, aborted: deps.pool.abort(sessionId) },
				};
			}
		}
	} catch (err) {
		return { reply: { type: "error", message: `shared session: ${(err as Error).message}` } };
	}
	return { reply: { type: "error", message: "unknown message type" } };
}

/**
 * Write a shareable session's user/assistant history to the session store so
 * the TUI and a later session:attach can resume it. Never throws.
 */
export function persistSession(
	pool: SharedPool,
	store: () => SharedStore,
	sessionId: string,
): boolean {
	try {
		// Stand-in pools without session info have nothing to save.
		if (!isSessionId(sessionId) || typeof pool.getSessionInfo !== "function") return false;
		const info = pool.getSessionInfo(sessionId);
		const agent = pool.getAgent(sessionId);
		if (!info || !agent || !SHAREABLE_CHANNELS.has(info.channel)) return false;
		const messages = chatMessages(agent.getMessageHistory()).slice(-PERSIST_MAX_MESSAGES);
		if (messages.length === 0) return false;
		store().save(sessionId, messages, {
			channel: info.channel,
			model: agent.getModel?.(),
			provider: agent.getRuntime?.(),
			cwd: agent.getWorkingDirectory?.(),
		});
		return true;
	} catch (err) {
		console.error(`[shared-sessions] could not save session ${sessionId}: ${String(err)}`);
		return false;
	}
}
