import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";
import { SessionStore, latestSessionForCwd } from "./session-store";

let dir: string;
let mgr: SessionManager;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-"));
	mgr = new SessionManager(dir);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const m = (role: string, content: string) => ({ role, content });

describe("SessionManager on the tree store", () => {
	test("create, update, resume by id and by name, list, getLast", () => {
		const s = mgr.create({ name: "Auth Fix", model: "qwen", cwd: "/work/a" });
		mgr.update(s.id, [m("user", "hi"), m("assistant", "yo")], { model: "qwen2" });
		expect(fs.existsSync(path.join(dir, "tree", `${s.id}.jsonl`))).toBe(true);
		expect(fs.existsSync(path.join(dir, `${s.id}.json`))).toBe(false);

		const r = mgr.resume("auth");
		expect(r).toMatchObject({
			id: s.id,
			name: "Auth Fix",
			model: "qwen2",
			messageCount: 2,
			cwd: path.resolve("/work/a"),
		});
		expect(r?.messages).toEqual([m("user", "hi"), m("assistant", "yo")]);
		expect(mgr.resume(s.id)?.id).toBe(s.id);
		expect(mgr.list()).toHaveLength(1);
		expect(mgr.getLast()?.id).toBe(s.id);
		expect(latestSessionForCwd("/work/a", dir)?.id).toBe(s.id);
	});

	test("a shorter or edited save keeps the old messages on a branch", () => {
		const s = mgr.create();
		mgr.update(s.id, [m("user", "a"), m("assistant", "b"), m("user", "c")]);
		mgr.update(s.id, [m("user", "a"), m("assistant", "b2")]);
		expect(mgr.get(s.id)?.messages).toEqual([m("user", "a"), m("assistant", "b2")]);
		const store = mgr.store(s.id) as SessionStore;
		expect(store.leaves()).toHaveLength(2);
		expect(store.allEntries().map((e) => e.type === "message" && e.message.content)).toEqual([
			"a",
			"b",
			"c",
			"b2",
		]);
	});

	test("rename and update are no-ops for an unknown id; save creates", () => {
		mgr.rename("nope", "x");
		mgr.update("nope", [m("user", "x")]);
		expect(mgr.get("nope")).toBeNull();
		mgr.save("daemon1", [m("user", "x")], { channel: "browser", cwd: "/w" });
		expect(mgr.get("daemon1")).toMatchObject({
			channel: "browser",
			cwd: path.resolve("/w"),
			messageCount: 1,
		});
		mgr.save("daemon1", [m("user", "x"), m("assistant", "y")], { channel: "tui" });
		expect(mgr.get("daemon1")).toMatchObject({ channel: "tui", messageCount: 2 });
	});

	test("ids that are not plain file names are refused", () => {
		expect(mgr.get("../../etc/passwd")).toBeNull();
		expect(() => mgr.save("../x", [])).toThrow();
	});
});

describe("sessions saved before the tree store", () => {
	function writeLegacy(id: string, extra: Record<string, unknown> = {}) {
		const now = "2026-10-01T10:00:00.000Z";
		fs.writeFileSync(
			path.join(dir, `${id}.json`),
			JSON.stringify({
				id,
				name: "old one",
				model: "m",
				provider: "p",
				cwd: "/work/old",
				messageCount: 2,
				createdAt: now,
				lastActiveAt: now,
				messages: [m("user", "q"), m("assistant", "a")],
				...extra,
			}),
		);
	}

	test("are listed and resumed without being changed", () => {
		writeLegacy("leg1");
		const before = fs.readFileSync(path.join(dir, "leg1.json"), "utf-8");
		expect(mgr.list().map((s) => s.id)).toEqual(["leg1"]);
		expect(mgr.resume("old")?.messages).toEqual([m("user", "q"), m("assistant", "a")]);
		expect(latestSessionForCwd("/work/old", dir)?.id).toBe("leg1");
		expect(fs.readFileSync(path.join(dir, "leg1.json"), "utf-8")).toBe(before);
		expect(SessionStore.exists("leg1", dir)).toBe(false);
	});

	test("the first write copies them into the tree under the same id; the old file stays", () => {
		writeLegacy("leg2", { channel: "tui" });
		mgr.update("leg2", [m("user", "q"), m("assistant", "a"), m("user", "more")]);
		const store = SessionStore.open("leg2", dir) as SessionStore;
		expect(store.header).toMatchObject({
			cwd: path.resolve("/work/old"),
			createdAt: "2026-10-01T10:00:00.000Z",
		});
		expect(store.name).toBe("old one");
		expect(store.allEntries()).toHaveLength(3);
		expect(fs.existsSync(path.join(dir, "leg2.json"))).toBe(true);
		expect(mgr.list().filter((s) => s.id === "leg2")).toHaveLength(1);
		expect(mgr.get("leg2")).toMatchObject({ channel: "tui", messageCount: 3 });
	});
});

describe("review fixes (#3986)", () => {
	test("TUI, /share and daemon shapes of one chat do not branch", () => {
		const tui = [m("user", "q"), m("system", "Resumed"), m("assistant", "a")];
		mgr.save("s_mix", tui);
		mgr.save("s_mix", [m("user", "q"), m("assistant", "a"), m("user", "q2")]);
		mgr.save("s_mix", [...tui, m("user", "q2")]);
		const store = mgr.store("s_mix") as SessionStore;
		expect(store.leaves()).toHaveLength(1);
		expect(store.allEntries()).toHaveLength(3);
		expect(mgr.get("s_mix")?.messages).toEqual([
			m("user", "q"),
			m("assistant", "a"),
			m("user", "q2"),
		]);
	});

	test("picker count and get() agree", () => {
		const s = mgr.create({ cwd: "/work/c" });
		mgr.update(s.id, [m("user", "a"), m("assistant", "b"), m("user", "c")]);
		mgr.update(s.id, [m("user", "a"), m("assistant", "b2")]);
		expect(latestSessionForCwd("/work/c", dir)?.messageCount).toBe(mgr.get(s.id)?.messageCount);
		expect(mgr.list()[0].messageCount).toBe(2);
	});
});

describe("typed desktop text never reaches the session file (8SO, #4057)", () => {
	// A local model writes its tool calls into the reply, in three shapes.
	const fenced = [
		"Typing it now.",
		"```tool_call",
		JSON.stringify({
			name: "desktop_act",
			arguments: { target: "field", action: "type", text: 'hunter2 "x"' },
		}),
		"```",
	].join("\n");
	const stringArgs = JSON.stringify({
		name: "desktop_type",
		arguments: JSON.stringify({ text: 'hunter2 "x"' }),
	});
	const xml =
		"<tool_call><function=desktop_type><parameter=text>hunter2 x</parameter></function></tool_call>";

	test("save, save again, --continue: the length is stored, the text never is, nothing branches", () => {
		const s = mgr.create({ name: "desk", cwd: "/work/d" });
		const turn1 = [m("user", "type my password"), m("assistant", fenced)];
		mgr.update(s.id, turn1);
		mgr.update(s.id, [
			...turn1,
			m("user", "again"),
			m("assistant", stringArgs),
			m("assistant", xml),
		]);

		const file = fs.readFileSync(path.join(dir, "tree", `${s.id}.jsonl`), "utf-8");
		expect(file).not.toContain("hunter2");
		expect(file).not.toContain('"type":"branch');

		const r = mgr.resume(s.id);
		const replay = (r?.messages ?? []).map((x) => String(x.content));
		expect(replay).toHaveLength(5);
		expect(replay.join("\n")).not.toContain("hunter2");
		expect(replay[1]).toContain('"textLength":11');
		expect(replay[1]).toContain('"target":"field"');
		expect(replay[3]).toContain('\\"textLength\\":11');
		expect(replay[4]).toContain("<parameter=textLength>9</parameter>");
		const store = SessionStore.open(s.id, dir);
		expect(store?.leaves()).toHaveLength(1);
	});

	test("a reply that names no desktop tool is stored as written", () => {
		const s = mgr.create({ name: "plain", cwd: "/work/p" });
		const body = 'Use {"text": "hello"} as the payload.';
		mgr.update(s.id, [m("user", "q"), m("assistant", body)]);
		expect(mgr.resume(s.id)?.messages?.[1]).toEqual(m("assistant", body));
	});
});
