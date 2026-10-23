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

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { isSessionId } from "../eight/session-manager";
import { type ChatMessage, chatMessages, isHarnessNote } from "../eight/session-messages";

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

export type { ChatMessage };
export { chatMessages, isHarnessNote };

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
	/** False when a new session on `channel` would push the pool past its caps. */
	canCreate(channel: string): boolean;
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
	| {
			type: "session:resumed";
			sessionId: string;
			restored?: boolean;
			messageCount?: number;
			/** Proves a later remote resume is this client's (#3929). */
			resumeSecret?: string;
	  }
	| { type: "session:list"; live: LiveSession[]; past: PastSession[] }
	| {
			type: "session:attached";
			resumeSecret?: string;
			sessionId: string;
			channel: string;
			busy: boolean;
			restored: boolean;
			transcript: ChatMessage[];
			truncated: boolean;
			/** True for the Telegram home session (#4834). */
			home?: boolean;
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
	/**
	 * Sessions whose file in the store this daemon may write: restored from it,
	 * or shared when no file existed. Anything else is never saved, so a
	 * session can never overwrite a transcript it was not restored from.
	 */
	persistable: Set<string>;
	/** Per-connection rate limit for restores from disk. False = refuse. */
	allowRestore(): boolean;
	/** The connection proved the operator token (#4834). Required for the home session. */
	operator?: boolean;
	/** The session bound to the Telegram bridge's socket, if one is connected (#4834). */
	homeSessionId?: string | null;
}

/** The alias a client sends instead of the home session's id. */
export const HOME_ALIAS = "home";

export interface SharedSessionResult {
	reply: SharedSessionOutbound;
	/** Rebind the connection: a session id, null to unbind, undefined to leave as is. */
	bind?: string | null;
	/** The surface the connection declared, when it is a shareable one. */
	surface?: string;
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

type Fail = { error: string };

/**
 * Bring a saved session back into the pool: its channel (a file with none was
 * written by the TUI, so "tui"), its directory when it still exists, and its
 * messages. Refused when the pool has no room or the connection restores too
 * often. Marks the session persistable: it now owns that file.
 */
function restoreFromStore(
	sessionId: string,
	deps: SharedSessionDeps,
): { channel: string; messages: ChatMessage[] } | Fail | null {
	const past = deps.store.get(sessionId);
	if (!past) return null;
	const channel = typeof past.channel === "string" ? past.channel : "tui";
	if (!SHAREABLE_CHANNELS.has(channel)) return { error: "session cannot be shared" };
	if (!deps.pool.canCreate(channel)) {
		return { error: "too many 8gent sessions are open; close one, then try again" };
	}
	if (!deps.allowRestore()) return { error: "too many restores; wait a minute, then try again" };
	// The directory comes from the local file, never the wire, and must exist.
	const workingDirectory = isDirectory(past.cwd) ? past.cwd : undefined;
	deps.pool.createSession(sessionId, channel, workingDirectory ? { workingDirectory } : undefined);
	const agent = deps.pool.getAgent(sessionId);
	if (!agent) return { error: "session could not be restored" };
	const messages = chatMessages(Array.isArray(past.messages) ? past.messages : []);
	agent.restoreFromCheckpoint(messages);
	deps.persistable.add(sessionId);
	return { channel, messages };
}

/** Saving a live session the first time it is shared: only when no file is in the way. */
function markShared(sessionId: string, deps: SharedSessionDeps): void {
	if (!deps.persistable.has(sessionId) && !deps.store.get(sessionId))
		deps.persistable.add(sessionId);
}

function attachLive(sessionId: string, deps: SharedSessionDeps): SharedSessionResult {
	const info = deps.pool.getSessionInfo(sessionId);
	const agent = deps.pool.getAgent(sessionId);
	if (!info || !agent) return { reply: { type: "error", message: "session not found" } };
	// The one private session a surface may join: the Telegram home session, by an
	// operator-token socket (#4834). It is never marked persistable, so the TUI can
	// never cause it to be written under ~/.8gent/sessions.
	const home = info.channel === "telegram" && sessionId === deps.homeSessionId;
	if (home && deps.operator !== true) {
		return { reply: { type: "error", message: "operator token required" } };
	}
	if (!home && !SHAREABLE_CHANNELS.has(info.channel)) {
		return { reply: { type: "error", message: "session cannot be shared" } };
	}
	if (!home) markShared(sessionId, deps);
	return {
		bind: sessionId,
		reply: {
			type: "session:attached",
			sessionId,
			channel: info.channel,
			busy: info.busy,
			restored: false,
			...(home ? { home: true } : {}),
			...capTranscript(chatMessages(agent.getMessageHistory())),
		},
	};
}

function attachPast(sessionId: string, deps: SharedSessionDeps): SharedSessionResult {
	const r = restoreFromStore(sessionId, deps);
	if (!r) return { reply: { type: "error", message: "session not found" } };
	if ("error" in r) return { reply: { type: "error", message: r.error } };
	return {
		bind: sessionId,
		reply: {
			type: "session:attached",
			sessionId,
			channel: r.channel,
			busy: false,
			restored: true,
			...capTranscript(r.messages),
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
				let target = msg.sessionId;
				if (target === HOME_ALIAS) {
					if (deps.operator !== true) {
						return { reply: { type: "error", message: "operator token required" } };
					}
					if (!deps.homeSessionId) {
						return { reply: { type: "error", message: "no home session" } };
					}
					target = deps.homeSessionId;
				}
				if (!isSessionId(target)) {
					return { reply: { type: "error", message: "invalid session id" } };
				}
				const result = deps.pool.hasSession(target)
					? attachLive(target, deps)
					: attachPast(target, deps);
				if (result.bind && typeof msg.channel === "string" && SHAREABLE_CHANNELS.has(msg.channel)) {
					result.surface = msg.channel;
				}
				return result;
			}

			case "session:detach":
				return { bind: null, reply: { type: "session:detached", sessionId: deps.boundSessionId } };

			case "session:abort": {
				// Only the connection's own session: a client cannot stop a turn on a
				// session it is not on.
				const sessionId = deps.boundSessionId;
				if (!sessionId) return { reply: { type: "error", message: "no session to stop" } };
				if (msg.sessionId !== undefined && msg.sessionId !== sessionId) {
					return { reply: { type: "error", message: "can only stop the session you are on" } };
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

export interface ResumeDeps extends SharedSessionDeps {
	/** The connection is the registered Telegram approval bridge. */
	isBridge: boolean;
	/** The connection's peer is loopback. */
	loopback: boolean;
	/** The channel this connection would use (from the frame or its state). */
	channel: string;
	/** The frame carried this session's resume secret. */
	resumeSecretOk: boolean;
}

/**
 * session:resume (v1.0) with the shared-session rules applied (#3929):
 *
 * - a live session on a private channel (telegram, table, delegation, computer)
 *   is only resumed by the approval bridge, and only a telegram one;
 * - joining a live session other clients are on is a share: loopback only;
 * - a saved session that is not live is restored from the store, with its
 *   history, exactly like session:attach (loopback only), never recreated empty
 *   under its id, which let the next save overwrite the file;
 * - anything else is the old behaviour: a new session under that id.
 */
export function handleResume(sessionId: unknown, deps: ResumeDeps): SharedSessionResult {
	try {
		if (!isSessionId(sessionId)) return { reply: { type: "error", message: "invalid session id" } };
		const fail = (message: string): SharedSessionResult => ({ reply: { type: "error", message } });

		if (deps.pool.hasSession(sessionId)) {
			const info = deps.pool.getSessionInfo(sessionId);
			const channel = info?.channel ?? deps.channel;
			if (!SHAREABLE_CHANNELS.has(channel)) {
				if (!(deps.isBridge && channel === "telegram")) return fail("session cannot be shared");
			} else if (deps.clientsOn(sessionId) > 0 && !deps.loopback) {
				return fail("shared sessions are loopback-only");
			}
			// A remote client proves the session is its own with the secret it was
			// given at create/attach/resume; holding a live id is not enough.
			if (!deps.loopback && !deps.resumeSecretOk) return fail("resume secret required");
			return { bind: sessionId, reply: { type: "session:resumed", sessionId } };
		}

		if (deps.store.get(sessionId)) {
			if (!deps.loopback) return fail("shared sessions are loopback-only");
			const r = restoreFromStore(sessionId, deps);
			if (!r) return fail("session not found");
			if ("error" in r) return fail(r.error);
			return {
				bind: sessionId,
				surface: r.channel,
				reply: {
					type: "session:resumed",
					sessionId,
					restored: true,
					messageCount: r.messages.length,
				},
			};
		}

		if (!SHAREABLE_CHANNELS.has(deps.channel) && !(deps.isBridge && deps.channel === "telegram")) {
			return fail("session cannot be shared");
		}
		deps.pool.createSession(sessionId, deps.channel);
		return { bind: sessionId, reply: { type: "session:resumed", sessionId } };
	} catch (err) {
		return { reply: { type: "error", message: `resume: ${(err as Error).message}` } };
	}
}

/**
 * Write a shared session's user/assistant history to the session store so the
 * TUI and a later session:attach can resume it. Only sessions in
 * `persistable` (restored from their file, or shared with no file in the way)
 * are written. Never throws.
 */
export function persistSession(
	pool: SharedPool,
	store: () => SharedStore,
	sessionId: string,
	persistable: ReadonlySet<string>,
): boolean {
	try {
		if (!persistable.has(sessionId) || !isSessionId(sessionId)) return false;
		// Stand-in pools without session info have nothing to save.
		if (typeof pool.getSessionInfo !== "function") return false;
		const info = pool.getSessionInfo(sessionId);
		const agent = pool.getAgent(sessionId);
		if (!info || !agent || !SHAREABLE_CHANNELS.has(info.channel)) return false;
		const messages = chatMessages(agent.getMessageHistory());
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

/**
 * Per-session resume secrets (#3929). Handed out in session:created,
 * session:attached and session:resumed as `resumeSecret`; a non-loopback
 * session:resume of a live session must send it back.
 */
export class ResumeSecrets {
	private secrets = new Map<string, string>();

	/** The session's secret, made on first use. */
	issue(sessionId: string): string {
		let secret = this.secrets.get(sessionId);
		if (!secret) {
			secret = randomBytes(16).toString("hex");
			this.secrets.set(sessionId, secret);
		}
		return secret;
	}

	matches(sessionId: string, given: unknown): boolean {
		const want = this.secrets.get(sessionId);
		if (!want || typeof given !== "string" || given.length !== want.length) return false;
		return timingSafeEqual(Buffer.from(given), Buffer.from(want));
	}

	forget(sessionId: string): void {
		this.secrets.delete(sessionId);
	}
}
