/**
 * #3929: shared-session verbs over a stand-in pool and the real session store.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../eight/session-manager";
import {
	type ChatMessage,
	type SharedAgent,
	type SharedPool,
	type SharedSessionDeps,
	type SharedStore,
	TRANSCRIPT_MAX_CHARS,
	TRANSCRIPT_MAX_MESSAGES,
	capTranscript,
	handleSharedSession,
	persistSession,
} from "./shared-sessions";

class FakeAgent implements SharedAgent {
	history: Array<{ role: string; content: unknown }> = [{ role: "system", content: "sys" }];
	aborted = 0;
	constructor(readonly cwd: string | undefined) {}
	getMessageHistory() {
		return [...this.history];
	}
	restoreFromCheckpoint(messages: ChatMessage[]) {
		this.history = [this.history[0], ...messages];
	}
	abort() {
		this.aborted++;
	}
	getModel() {
		return "eight:latest";
	}
	getRuntime() {
		return "ollama";
	}
	getWorkingDirectory() {
		return this.cwd ?? "/pool/default";
	}
}

class FakePool implements SharedPool {
	live = new Map<string, { channel: string; agent: FakeAgent; busy: boolean }>();
	add(id: string, channel: string, busy = false) {
		this.live.set(id, { channel, agent: new FakeAgent(undefined), busy });
		return this.live.get(id)!.agent;
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	createSession(id: string, channel: string, overrides?: { workingDirectory?: string }) {
		this.live.set(id, { channel, agent: new FakeAgent(overrides?.workingDirectory), busy: false });
	}
	getAgent(id: string) {
		return this.live.get(id)?.agent ?? null;
	}
	getSessionInfo(id: string) {
		const e = this.live.get(id);
		if (!e) return null;
		return { channel: e.channel, messageCount: 1, busy: e.busy, createdAt: 1, lastActiveAt: 2 };
	}
	getActiveSessions() {
		return [...this.live].map(([sessionId, e]) => ({ sessionId, channel: e.channel }));
	}
	abort(id: string) {
		const e = this.live.get(id);
		if (!e?.busy) return false;
		e.agent.abort();
		return true;
	}
}

let dir: string;
let store: SessionManager;
let pool: FakePool;
const deps = (bound: string | null = null): SharedSessionDeps => ({
	pool,
	store: store as unknown as SharedStore,
	boundSessionId: bound,
	clientsOn: () => 2,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shared-sessions-"));
	store = new SessionManager(join(dir, "sessions"));
	pool = new FakePool();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("session:list", () => {
	it("lists only shareable live sessions, and past ones that are not live", () => {
		pool.add("s_tui", "tui");
		pool.add("s_tg", "telegram");
		pool.add("s_table", "table");
		const past = store.create({ name: "auth bug", model: "m" });
		store.save("s_tui", [{ role: "user", content: "hi" }], { channel: "tui" });
		store.save("s_tgpast", [{ role: "user", content: "x" }], { channel: "telegram" });

		const { reply } = handleSharedSession({ type: "session:list" }, deps());
		if (reply.type !== "session:list") throw new Error(reply.type);
		expect(reply.live.map((l) => l.sessionId)).toEqual(["s_tui"]);
		expect(reply.live[0]).toMatchObject({ channel: "tui", clients: 2, busy: false });
		// s_tui is live, so it is not repeated under past; telegram is never listed.
		expect(reply.past.map((p) => p.sessionId)).toEqual([past.id]);
		expect(reply.past[0]).toMatchObject({ channel: "tui", title: "auth bug" });
	});

	it("past: false skips the store", () => {
		store.create({ name: "x" });
		const { reply } = handleSharedSession({ type: "session:list", past: false }, deps());
		expect(reply).toEqual({ type: "session:list", live: [], past: [] });
	});
});

describe("session:attach", () => {
	it("binds to a live session and returns its user/assistant transcript", () => {
		const agent = pool.add("s_live", "browser");
		agent.history.push(
			{ role: "user", content: "fix it" },
			{ role: "tool", content: "ran" },
			{ role: "assistant", content: "done" },
		);
		const r = handleSharedSession({ type: "session:attach", sessionId: "s_live" }, deps());
		expect(r.bind).toBe("s_live");
		expect(r.reply).toEqual({
			type: "session:attached",
			sessionId: "s_live",
			channel: "browser",
			busy: false,
			restored: false,
			transcript: [
				{ role: "user", content: "fix it" },
				{ role: "assistant", content: "done" },
			],
			truncated: false,
		});
	});

	it("restores a past TUI session into the pool, in its own directory", () => {
		const info = store.create({ cwd: dir });
		store.update(info.id, [
			{ role: "system", content: "Resumed session" },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi James" },
		]);
		const r = handleSharedSession({ type: "session:attach", sessionId: info.id }, deps());
		expect(r.bind).toBe(info.id);
		expect(r.reply).toMatchObject({ type: "session:attached", channel: "tui", restored: true });
		const agent = pool.getAgent(info.id)!;
		expect(agent.getWorkingDirectory()).toBe(dir);
		expect(agent.getMessageHistory().slice(1)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi James" },
		]);
	});

	it("ignores a saved directory that does not exist", () => {
		const info = store.create({ cwd: join(dir, "gone") });
		handleSharedSession({ type: "session:attach", sessionId: info.id }, deps());
		expect(pool.getAgent(info.id)!.getWorkingDirectory()).toBe("/pool/default");
	});

	it("refuses traversal ids before touching the disk", () => {
		writeFileSync(join(dir, "evil.json"), JSON.stringify({ id: "x", messages: [] }));
		for (const sessionId of ["../evil", "..", "a/b", "", "x".repeat(65), "a.b"]) {
			const r = handleSharedSession({ type: "session:attach", sessionId }, deps());
			expect(r.reply).toEqual({ type: "error", message: "invalid session id" });
			expect(r.bind).toBeUndefined();
		}
		expect(pool.live.size).toBe(0);
	});

	it("refuses telegram and table sessions, live or past", () => {
		pool.add("s_tg", "telegram");
		store.save("s_tablepast", [{ role: "user", content: "x" }], { channel: "table" });
		for (const sessionId of ["s_tg", "s_tablepast"]) {
			const r = handleSharedSession({ type: "session:attach", sessionId }, deps());
			expect(r.reply).toEqual({ type: "error", message: "session cannot be shared" });
			expect(r.bind).toBeUndefined();
		}
		expect(pool.hasSession("s_tablepast")).toBe(false);
	});

	it("says not found for an unknown id", () => {
		const r = handleSharedSession({ type: "session:attach", sessionId: "nope" }, deps());
		expect(r.reply).toEqual({ type: "error", message: "session not found" });
	});
});

describe("session:detach and session:abort", () => {
	it("detach unbinds without touching the session", () => {
		pool.add("s_a", "tui");
		const r = handleSharedSession({ type: "session:detach" }, deps("s_a"));
		expect(r).toEqual({ bind: null, reply: { type: "session:detached", sessionId: "s_a" } });
		expect(pool.hasSession("s_a")).toBe(true);
	});

	it("abort stops the bound session's turn and keeps the session", () => {
		const agent = pool.add("s_a", "tui", true);
		const r = handleSharedSession({ type: "session:abort" }, deps("s_a"));
		expect(r.reply).toEqual({ type: "session:aborted", sessionId: "s_a", aborted: true });
		expect(agent.aborted).toBe(1);
		expect(pool.hasSession("s_a")).toBe(true);
	});

	it("abort refuses a session it may not share", () => {
		const agent = pool.add("s_tg", "telegram", true);
		const r = handleSharedSession({ type: "session:abort", sessionId: "s_tg" }, deps());
		expect(r.reply).toEqual({ type: "error", message: "session cannot be shared" });
		expect(agent.aborted).toBe(0);
	});
});

describe("persistSession", () => {
	it("writes a shareable session in the TUI's format and the TUI can resume it", () => {
		const agent = pool.add("s_p", "browser");
		agent.history.push({ role: "user", content: "q" }, { role: "assistant", content: "a" });
		expect(persistSession(pool, () => store as unknown as SharedStore, "s_p")).toBe(true);
		const file = JSON.parse(readFileSync(join(dir, "sessions", "s_p.json"), "utf8"));
		expect(file).toMatchObject({
			id: "s_p",
			channel: "browser",
			messageCount: 2,
			model: "eight:latest",
		});
		expect(store.resume("s_p")?.messages).toEqual([
			{ role: "user", content: "q" },
			{ role: "assistant", content: "a" },
		]);
	});

	it("never writes telegram or table transcripts", () => {
		const agent = pool.add("s_tg", "telegram");
		agent.history.push({ role: "user", content: "secret" });
		expect(persistSession(pool, () => store as unknown as SharedStore, "s_tg")).toBe(false);
		expect(store.get("s_tg")).toBeNull();
	});
});

describe("capTranscript", () => {
	it("keeps the newest messages and caps each one", () => {
		const many = Array.from({ length: TRANSCRIPT_MAX_MESSAGES + 5 }, (_, i) => ({
			role: "user",
			content: String(i),
		}));
		const a = capTranscript(many);
		expect(a.transcript.length).toBe(TRANSCRIPT_MAX_MESSAGES);
		expect(a.transcript[0].content).toBe("5");
		expect(a.truncated).toBe(true);
		const b = capTranscript([{ role: "assistant", content: "x".repeat(TRANSCRIPT_MAX_CHARS + 1) }]);
		expect(b.truncated).toBe(true);
		expect(b.transcript[0].content.endsWith("[truncated]")).toBe(true);
	});
});
