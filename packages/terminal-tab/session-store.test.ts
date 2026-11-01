/**
 * Tests for session-store — persistence for window-spawned terminal
 * sessions. Survives 8gent restart so the TUI can reconnect to running
 * Terminal.app windows.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type WindowSession,
	deleteSession,
	getSession,
	loadSessions,
	pruneDead,
	saveSession,
} from "./session-store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const fixture = (overrides: Partial<WindowSession> = {}): WindowSession => ({
	sessionId: "term-test-001",
	command: "claude",
	args: [],
	label: "Claude Code",
	pid: process.pid, // a real live pid for prune tests
	cwd: process.cwd(),
	startedAt: new Date().toISOString(),
	source: "preset",
	...overrides,
});

describe("session-store — save/load roundtrip", () => {
	it("saves a session as JSON and loads it back", () => {
		const s = fixture();
		saveSession(s, dir);
		expect(existsSync(join(dir, `${s.sessionId}.json`))).toBe(true);
		const loaded = loadSessions(dir);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].sessionId).toBe("term-test-001");
		expect(loaded[0].command).toBe("claude");
	});

	it("loadSessions returns empty array when dir does not exist", () => {
		expect(loadSessions(join(dir, "missing"))).toEqual([]);
	});

	it("loadSessions skips malformed JSON instead of throwing", () => {
		writeFileSync(join(dir, "bad.json"), "{not json", "utf-8");
		saveSession(fixture(), dir);
		const loaded = loadSessions(dir);
		expect(loaded).toHaveLength(1);
	});

	it("getSession returns null for missing id", () => {
		expect(getSession("nonexistent", dir)).toBeNull();
	});

	it("deleteSession removes the JSON file", () => {
		const s = fixture();
		saveSession(s, dir);
		deleteSession(s.sessionId, dir);
		expect(existsSync(join(dir, `${s.sessionId}.json`))).toBe(false);
	});

	it("deleteSession is a no-op when the file is already gone", () => {
		expect(() => deleteSession("never-existed", dir)).not.toThrow();
	});
});

describe("session-store — pruneDead", () => {
	it("keeps sessions whose pid is still alive", () => {
		const live = fixture({ sessionId: "live", pid: process.pid });
		saveSession(live, dir);
		const remaining = pruneDead(dir);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].sessionId).toBe("live");
	});

	it("removes sessions whose pid is dead", () => {
		// PID 1 (init) on macOS is owned by root; we can't kill -0 it from a
		// non-root process — it returns EPERM, which means alive. Use a
		// definitely-dead high pid instead.
		const dead = fixture({ sessionId: "dead", pid: 999999 });
		saveSession(dead, dir);
		const remaining = pruneDead(dir);
		expect(remaining).toHaveLength(0);
		expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
	});

	it("preserves live sessions while pruning dead ones in the same pass", () => {
		saveSession(fixture({ sessionId: "live", pid: process.pid }), dir);
		saveSession(fixture({ sessionId: "dead", pid: 999999 }), dir);
		const remaining = pruneDead(dir);
		expect(remaining.map((s) => s.sessionId).sort()).toEqual(["live"]);
	});
});
