/**
 * #3929: shared-session verbs over a stand-in pool and the real session store.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_NOTE_HEADER, harnessNote } from "../eight/context-note";
import { planningGateInstruction } from "../eight/local-tool-scope";
import { SessionManager } from "../eight/session-manager";
import {
	type ChatMessage,
	type ResumeDeps,
	ResumeSecrets,
	type SharedAgent,
	type SharedPool,
	type SharedSessionDeps,
	type SharedStore,
	TRANSCRIPT_MAX_CHARS,
	TRANSCRIPT_MAX_MESSAGES,
	capTranscript,
	chatMessages,
	handleResume,
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
	room = true;
	canCreate() {
		return this.room;
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
let persistable: Set<string>;
let restoresAllowed: boolean;
const deps = (bound: string | null = null): SharedSessionDeps => ({
	pool,
	store: store as unknown as SharedStore,
	boundSessionId: bound,
	clientsOn: () => 2,
	persistable,
	allowRestore: () => restoresAllowed,
});
const resumeDeps = (over: Partial<ResumeDeps> = {}): ResumeDeps => ({
	...deps(),
	clientsOn: () => 0,
	isBridge: false,
	loopback: true,
	channel: "browser",
	resumeSecretOk: false,
	...over,
});
const saveStore = () => store as unknown as SharedStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shared-sessions-"));
	store = new SessionManager(join(dir, "sessions"));
	pool = new FakePool();
	persistable = new Set();
	restoresAllowed = true;
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

describe("the Telegram home session (#4834)", () => {
	const homeDeps = (over: Partial<SharedSessionDeps> = {}): SharedSessionDeps => ({
		...deps(),
		operator: true,
		homeSessionId: "s_home",
		...over,
	});
	const attach = (sessionId: string, d: SharedSessionDeps) =>
		handleSharedSession({ type: "session:attach", sessionId, channel: "tui" }, d);

	it("the home alias attaches it for an operator and marks it home", () => {
		const agent = pool.add("s_home", "telegram");
		agent.history.push({ role: "user", content: "from telegram" });
		const r = attach("home", homeDeps());
		expect(r.bind).toBe("s_home");
		if (r.reply.type !== "session:attached") throw new Error(JSON.stringify(r.reply));
		expect(r.reply).toMatchObject({ channel: "telegram", home: true, restored: false });
		expect(r.reply.transcript.map((m) => m.content)).toEqual(["from telegram"]);
	});

	it("its raw id is refused, operator or not: only the alias joins it, and nothing binds", () => {
		pool.add("s_home", "telegram");
		for (const operator of [true, false, undefined]) {
			const r = attach("s_home", homeDeps({ operator }));
			expect(r.bind).toBeUndefined();
			expect(r.reply).toEqual({ type: "error", message: "session cannot be shared" });
		}
		// The same answer as for any other private session: the id says nothing.
		pool.add("s_other_tg", "telegram");
		expect(attach("s_other_tg", homeDeps()).reply).toEqual(attach("s_home", homeDeps()).reply);
	});

	it("is refused without the operator token by alias and nothing binds", () => {
		pool.add("s_home", "telegram");
		for (const op of [false, undefined]) {
			const r = attach("home", homeDeps({ operator: op }));
			expect(r.bind).toBeUndefined();
			expect(r.reply).toEqual({ type: "error", message: "operator token required" });
		}
	});

	it("is refused when no bridge is connected, and for any other telegram session even with the token", () => {
		pool.add("s_other_tg", "telegram");
		expect(attach("home", homeDeps({ homeSessionId: null })).reply).toEqual({
			type: "error",
			message: "no home session",
		});
		expect(attach("s_other_tg", homeDeps()).reply).toEqual({
			type: "error",
			message: "session cannot be shared",
		});
	});

	it("other private channels stay private for an operator, home pointing at them or not", () => {
		pool.add("s_table", "table");
		pool.add("s_comp", "computer");
		expect(attach("s_table", homeDeps()).reply).toMatchObject({
			message: "session cannot be shared",
		});
		expect(attach("s_comp", homeDeps({ homeSessionId: "s_comp" })).reply).toMatchObject({
			message: "session cannot be shared",
		});
	});

	it("is never listed, never marked persistable, and never written by persistSession", () => {
		pool.add("s_home", "telegram");
		attach("home", homeDeps());
		expect(persistable.has("s_home")).toBe(false);
		persistSession(pool, () => saveStore(), "s_home", persistable);
		expect(store.get("s_home")).toBeNull();
		const { reply } = handleSharedSession({ type: "session:list" }, homeDeps());
		if (reply.type !== "session:list") throw new Error(reply.type);
		expect(reply.live).toEqual([]);
	});

	it("a TUI session's attach is unchanged for everyone", () => {
		pool.add("s_tui", "tui");
		const r = attach("s_tui", deps());
		expect(r.bind).toBe("s_tui");
		expect(persistable.has("s_tui")).toBe(true);
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
		const r = handleSharedSession({ type: "session:abort" }, deps("s_tg"));
		expect(r.reply).toEqual({ type: "error", message: "session cannot be shared" });
		expect(agent.aborted).toBe(0);
	});

	it("abort only stops the session this connection is on", () => {
		const other = pool.add("s_other", "tui", true);
		pool.add("s_mine", "tui");
		for (const bound of ["s_mine", null]) {
			const r = handleSharedSession({ type: "session:abort", sessionId: "s_other" }, deps(bound));
			expect(r.reply.type).toBe("error");
		}
		expect(other.aborted).toBe(0);
	});
});

describe("persistSession", () => {
	it("writes a shareable session in the TUI's format and the TUI can resume it", () => {
		const agent = pool.add("s_p", "browser");
		agent.history.push({ role: "user", content: "q" }, { role: "assistant", content: "a" });
		expect(persistSession(pool, saveStore, "s_p", new Set(["s_p"]))).toBe(true);
		const file = store.get("s_p");
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

	it("a session past 1000 messages keeps appending one turn at a time (#3986 review)", () => {
		const agent = pool.add("s_long", "browser");
		for (let i = 0; i < 1100; i++) {
			agent.history.push({ role: i % 2 ? "assistant" : "user", content: `m${i}` });
		}
		const persistable = new Set(["s_long"]);
		expect(persistSession(pool, saveStore, "s_long", persistable)).toBe(true);
		for (let t = 0; t < 3; t++) {
			agent.history.push(
				{ role: "user", content: `n${t}` },
				{ role: "assistant", content: `r${t}` },
			);
			expect(persistSession(pool, saveStore, "s_long", persistable)).toBe(true);
		}
		const tree = store.store("s_long")!;
		expect(tree.allEntries()).toHaveLength(1106);
		expect(tree.tree()).toHaveLength(1);
		expect(store.get("s_long")?.messageCount).toBe(1106);
	});

	it("never writes telegram or table transcripts", () => {
		const agent = pool.add("s_tg", "telegram");
		agent.history.push({ role: "user", content: "secret" });
		expect(persistSession(pool, saveStore, "s_tg", new Set(["s_tg"]))).toBe(false);
		expect(store.get("s_tg")).toBeNull();
	});
});

describe("persistence ownership", () => {
	it("never saves a session that is not persistable", () => {
		const agent = pool.add("s_q", "browser");
		agent.history.push({ role: "user", content: "q" });
		expect(persistSession(pool, saveStore, "s_q", new Set())).toBe(false);
		expect(store.get("s_q")).toBeNull();
	});

	it("attaching to a live session never claims a file it was not restored from", () => {
		store.save("s_clash", [{ role: "user", content: "older" }], { channel: "tui" });
		pool.add("s_clash", "browser");
		handleSharedSession({ type: "session:attach", sessionId: "s_clash" }, deps());
		expect(persistable.has("s_clash")).toBe(false);
		pool.add("s_free", "browser");
		handleSharedSession({ type: "session:attach", sessionId: "s_free" }, deps());
		expect(persistable.has("s_free")).toBe(true);
	});

	// Windows has no POSIX mode bits: stat reports 0o666 for any file, so the 0600 check cannot hold there.
	it.skipIf(process.platform === "win32")("session files are owner-only", () => {
		store.save("s_mode", [{ role: "user", content: "x" }], {});
		expect(statSync(join(dir, "sessions", "tree", "s_mode.jsonl")).mode & 0o777).toBe(0o600);
	});
});

describe("harness notes", () => {
	it("are dropped from transcripts, the store and restores", () => {
		const history = [
			{ role: "system", content: "sys" },
			{ role: "user", content: `${CONTEXT_NOTE_HEADER}\n\nmemory: James likes tea` },
			{ role: "user", content: "fix the build" },
			{ role: "user", content: planningGateInstruction(0) },
			{ role: "user", content: planningGateInstruction(3) },
			{ role: "user", content: harnessNote("vision: a screenshot of a terminal") },
			{ role: "assistant", content: "done" },
		];
		const want = [
			{ role: "user", content: "fix the build" },
			{ role: "assistant", content: "done" },
		];
		expect(chatMessages(history)).toEqual(want);

		// Disk: a live session's save holds only what was typed and answered.
		const agent = pool.add("s_notes", "browser");
		agent.history = history;
		expect(persistSession(pool, saveStore, "s_notes", new Set(["s_notes"]))).toBe(true);
		expect(store.get("s_notes")?.messages).toEqual(want);

		// Restore: a file that still carries notes (an older save) restores without them.
		store.save("s_old", history.slice(1), { channel: "tui" });
		const r = handleSharedSession({ type: "session:attach", sessionId: "s_old" }, deps());
		expect(r.reply).toMatchObject({ transcript: want });
		expect(pool.getAgent("s_old")!.getMessageHistory().slice(1)).toEqual(want);
	});
});

describe("session:resume (v1.0) under the shared-session rules", () => {
	it("restores a saved TUI session instead of recreating it empty (8PO repro)", () => {
		// The repro: a 4-message TUI file, resumed by a browser client while not live.
		const tui = store.create({ cwd: dir });
		const four = [
			{ role: "user", content: "one" },
			{ role: "assistant", content: "two" },
			{ role: "user", content: "three" },
			{ role: "assistant", content: "four" },
		];
		store.update(tui.id, four);
		const r = handleResume(tui.id, resumeDeps({ channel: "browser" }));
		expect(r.reply).toEqual({
			type: "session:resumed",
			sessionId: tui.id,
			restored: true,
			messageCount: 4,
		});
		expect(r.surface).toBe("tui");
		const agent = pool.getAgent(tui.id)!;
		expect(agent.getMessageHistory().slice(1)).toEqual(four);
		// One more turn, then the save keeps all of it and the channel stays tui.
		agent.history.push({ role: "user", content: "five" }, { role: "assistant", content: "six" });
		expect(persistSession(pool, saveStore, tui.id, persistable)).toBe(true);
		const file = store.get(tui.id)!;
		expect(file.messages.length).toBe(6);
		expect(file.channel).toBe("tui");
	});

	it("restoring from disk is loopback-only, capped and rate-limited", () => {
		const a = store.create();
		expect(handleResume(a.id, resumeDeps({ loopback: false })).reply).toEqual({
			type: "error",
			message: "shared sessions are loopback-only",
		});
		pool.room = false;
		expect(handleResume(a.id, resumeDeps()).reply).toMatchObject({ type: "error" });
		expect(
			handleSharedSession({ type: "session:attach", sessionId: a.id }, deps()).reply.type,
		).toBe("error");
		pool.room = true;
		restoresAllowed = false;
		expect(handleResume(a.id, resumeDeps()).reply).toMatchObject({ type: "error" });
		expect(pool.hasSession(a.id)).toBe(false);
	});

	it("keeps private sessions private: only the bridge resumes a telegram one", () => {
		pool.add("s_tg", "telegram");
		pool.add("s_tab", "table");
		expect(handleResume("s_tg", resumeDeps({ channel: "telegram" })).reply.type).toBe("error");
		expect(handleResume("s_tab", resumeDeps({ isBridge: true })).reply.type).toBe("error");
		const ok = handleResume("s_tg", resumeDeps({ isBridge: true, channel: "telegram" }));
		expect(ok).toMatchObject({ bind: "s_tg", reply: { type: "session:resumed" } });
		// A new telegram-channel session under a fresh id: the bridge only.
		expect(handleResume("s_new", resumeDeps({ channel: "telegram" })).reply.type).toBe("error");
		expect(handleResume("s_new", resumeDeps({ channel: "telegram", isBridge: true })).bind).toBe(
			"s_new",
		);
	});

	it("joining a live session others are on is loopback-only; a remote reconnect needs the secret", () => {
		pool.add("s_b", "browser");
		expect(
			handleResume("s_b", resumeDeps({ loopback: false, clientsOn: () => 1 })).reply.type,
		).toBe("error");
		// A remote reconnect needs the session's resume secret, even with nobody on it.
		expect(handleResume("s_b", resumeDeps({ loopback: false })).reply).toEqual({
			type: "error",
			message: "resume secret required",
		});
		expect(handleResume("s_b", resumeDeps({ loopback: false, resumeSecretOk: true })).bind).toBe(
			"s_b",
		);
	});

	it("rejects ids that are not plain", () => {
		expect(handleResume("../x", resumeDeps()).reply).toEqual({
			type: "error",
			message: "invalid session id",
		});
	});
});

describe("ResumeSecrets", () => {
	it("issues one secret per session and only that secret matches", () => {
		const secrets = new ResumeSecrets();
		const a = secrets.issue("s_a");
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(secrets.issue("s_a")).toBe(a);
		expect(secrets.issue("s_b")).not.toBe(a);
		expect(secrets.matches("s_a", a)).toBe(true);
		expect(secrets.matches("s_b", a)).toBe(false);
		expect(secrets.matches("s_a", undefined)).toBe(false);
		expect(secrets.matches("s_a", `${a}x`)).toBe(false);
		expect(secrets.matches("s_unknown", a)).toBe(false);
		secrets.forget("s_a");
		expect(secrets.matches("s_a", a)).toBe(false);
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
