import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store";

const created: string[] = [];

function tmpFile(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tg-session-"));
	created.push(dir);
	return join(dir, name);
}

afterEach(() => {
	while (created.length) {
		const dir = created.pop();
		if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionStore", () => {
	it("creates a session lazily and tracks state", () => {
		const store = new SessionStore();
		const s = store.getOrCreate("123");
		expect(s.chatId).toBe("123");
		expect(s.sessionId).toBeNull();
		store.setSessionId("123", "sess_abc");
		store.linkTask("123", "task_42");
		expect(store.get("123")?.sessionId).toBe("sess_abc");
		expect(store.currentTask("123")).toBe("task_42");
	});

	it("trims history to the configured limit", () => {
		const store = new SessionStore({ historyLimit: 3 });
		for (let i = 0; i < 10; i++) {
			store.recordMessage("c", i % 2 === 0 ? "user" : "bot", `msg-${i}`);
		}
		const s = store.get("c");
		expect(s?.history.length).toBe(3);
		expect(s?.history[s.history.length - 1].text).toBe("msg-9");
	});

	it("persists and reloads from disk", () => {
		const path = tmpFile("sessions.json");
		const store = new SessionStore({ persistPath: path, flushDebounceMs: 0 });
		store.setSessionId("42", "sess_persist");
		store.recordMessage("42", "user", "hi");
		store.flush();

		const reloaded = new SessionStore({ persistPath: path });
		const s = reloaded.get("42");
		expect(s?.sessionId).toBe("sess_persist");
		expect(s?.history[0].text).toBe("hi");
	});

	it("survives a corrupt persistence file", () => {
		const path = tmpFile("sessions.json");
		require("node:fs").writeFileSync(path, "{not json", "utf-8");
		const store = new SessionStore({ persistPath: path });
		expect(store.all().length).toBe(0);
	});
});
