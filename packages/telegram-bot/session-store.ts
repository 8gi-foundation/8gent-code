/**
 * @8gent/telegram-bot - Session Store
 *
 * Per-chat conversation context. Maps Telegram chat IDs to a daemon session
 * (so messages flow to the same Agent across turns) and tracks the in-flight
 * task. Optionally persists to disk so sessions survive bot restarts.
 *
 * Persistence is best-effort: the bot continues to work if the file is
 * unwritable. We never lose state if the file is corrupt - we just start
 * fresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChatSession {
	chatId: string;
	sessionId: string | null;
	currentTaskId: string | null;
	lastMessageId: number | null;
	createdAt: number;
	lastActiveAt: number;
	messageCount: number;
	/** Bounded ring buffer of recent (user, bot) message pairs for context. */
	history: Array<{ role: "user" | "bot"; text: string; at: number }>;
}

export interface SessionStoreConfig {
	/** Optional disk file. If unset, the store is in-memory only. */
	persistPath?: string;
	/** How many history entries to keep per chat (default 40). */
	historyLimit?: number;
	/** Auto-flush debounce window in ms (default 2000). */
	flushDebounceMs?: number;
}

export class SessionStore {
	private sessions = new Map<string, ChatSession>();
	private persistPath?: string;
	private historyLimit: number;
	private flushDebounceMs: number;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config: SessionStoreConfig = {}) {
		this.persistPath = config.persistPath;
		this.historyLimit = config.historyLimit ?? 40;
		this.flushDebounceMs = config.flushDebounceMs ?? 2000;
		this.load();
	}

	get(chatId: string): ChatSession | undefined {
		return this.sessions.get(chatId);
	}

	getOrCreate(chatId: string): ChatSession {
		let session = this.sessions.get(chatId);
		if (!session) {
			session = {
				chatId,
				sessionId: null,
				currentTaskId: null,
				lastMessageId: null,
				createdAt: Date.now(),
				lastActiveAt: Date.now(),
				messageCount: 0,
				history: [],
			};
			this.sessions.set(chatId, session);
			this.scheduleFlush();
		}
		return session;
	}

	setSessionId(chatId: string, sessionId: string | null): void {
		const s = this.getOrCreate(chatId);
		s.sessionId = sessionId;
		s.lastActiveAt = Date.now();
		this.scheduleFlush();
	}

	linkTask(chatId: string, taskId: string | null): void {
		const s = this.getOrCreate(chatId);
		s.currentTaskId = taskId;
		s.lastActiveAt = Date.now();
		this.scheduleFlush();
	}

	currentTask(chatId: string): string | null {
		return this.sessions.get(chatId)?.currentTaskId ?? null;
	}

	recordMessage(chatId: string, role: "user" | "bot", text: string): void {
		const s = this.getOrCreate(chatId);
		s.history.push({ role, text, at: Date.now() });
		while (s.history.length > this.historyLimit) s.history.shift();
		s.messageCount++;
		s.lastActiveAt = Date.now();
		this.scheduleFlush();
	}

	clear(chatId: string): void {
		this.sessions.delete(chatId);
		this.scheduleFlush();
	}

	all(): ChatSession[] {
		return Array.from(this.sessions.values());
	}

	/** Force a synchronous write. Used in tests and on shutdown. */
	flush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (!this.persistPath) return;
		try {
			mkdirSync(dirname(this.persistPath), { recursive: true });
			const data = JSON.stringify(
				{ version: 1, savedAt: Date.now(), sessions: Array.from(this.sessions.values()) },
				null,
				2,
			);
			writeFileSync(this.persistPath, data, "utf-8");
		} catch {
			// Persist is best-effort; in-memory state remains valid.
		}
	}

	private scheduleFlush(): void {
		if (!this.persistPath) return;
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, this.flushDebounceMs);
	}

	private load(): void {
		if (!this.persistPath) return;
		try {
			if (!existsSync(this.persistPath)) return;
			const raw = readFileSync(this.persistPath, "utf-8");
			const parsed = JSON.parse(raw) as { sessions?: ChatSession[] };
			if (!parsed?.sessions) return;
			for (const s of parsed.sessions) {
				if (!s.chatId) continue;
				this.sessions.set(s.chatId, {
					...s,
					history: Array.isArray(s.history) ? s.history : [],
				});
			}
		} catch {
			// Corrupt file - start fresh, don't crash the bot.
		}
	}
}
