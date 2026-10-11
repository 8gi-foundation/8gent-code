import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, latestSessionForCwd, listSessions, treeDir } from "./session-store";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const user = (content: string) => ({ role: "user", content });
const asst = (content: string) => ({ role: "assistant", content });

/** Back-date a session file so recency ordering is deterministic. */
function touch(file: string, msAgo: number): void {
	const t = new Date(Date.now() - msAgo);
	fs.utimesSync(file, t, t);
}

describe("SessionStore file format", () => {
	test("writes a header line then one line per entry, and reopens to the same path", () => {
		const s = SessionStore.create({ cwd: "/work/a", name: "first" }, dir);
		const a = s.append(user("hi"));
		const b = s.append(asst("hello"));
		const lines = fs
			.readFileSync(s.file, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({ type: "session", id: s.id, cwd: path.resolve("/work/a") });
		expect(lines.filter((l) => l.type === "message").map((l) => [l.id, l.parentId])).toEqual([
			[a, null],
			[b, a],
		]);

		const again = SessionStore.open(s.id, dir);
		expect(again?.name).toBe("first");
		expect(again?.leafId).toBe(b);
		expect(again?.messages()).toEqual([user("hi"), asst("hello")]);
	});

	test("files are owner-only", () => {
		if (process.platform === "win32") return;
		const s = SessionStore.create({ cwd: dir }, dir);
		s.append(user("secret"));
		expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
	});

	test("a torn last line from a crash is skipped, the rest loads", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		s.append(user("one"));
		fs.appendFileSync(s.file, '{"type":"message","id":"zz","par');
		expect(SessionStore.open(s.id, dir)?.messages()).toEqual([user("one")]);
	});

	test("a torn last line followed by two appends: the fragment is cut, every later line survives", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		s.append(user("a"));
		fs.appendFileSync(s.file, '{"type":"message","id":"zz","par');
		SessionStore.open(s.id, dir)?.append(user("b"));
		SessionStore.open(s.id, dir)?.append(user("c"));
		const text = fs.readFileSync(s.file, "utf-8");
		expect(text).not.toContain('"zz"');
		expect(text.endsWith("\n")).toBe(true);
		expect(SessionStore.open(s.id, dir)?.messages()).toEqual([user("a"), user("b"), user("c")]);
	});

	test("create never overwrites or follows what is already at the path", () => {
		const s = SessionStore.create({ cwd: dir, id: "fixed1" }, dir);
		s.append(user("kept"));
		// Same explicit id again (a racing migration): reopens, keeps the history.
		const again = SessionStore.create({ cwd: dir, id: "fixed1" }, dir);
		expect(again.messages()).toEqual([user("kept")]);
		if (process.platform === "win32") return;
		// A planted symlink is not followed: create refuses rather than writing through it.
		const target = path.join(dir, "victim.txt");
		fs.writeFileSync(target, "untouched");
		fs.symlinkSync(target, path.join(treeDir(dir), "planted.jsonl"));
		expect(() => SessionStore.create({ cwd: dir, id: "planted" }, dir)).toThrow();
		expect(fs.readFileSync(target, "utf-8")).toBe("untouched");
	});

	test("a __proto__ key in a session_info line pollutes nothing", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		fs.appendFileSync(
			s.file,
			'{"type":"session_info","ts":"t","__proto__":{"polluted":1},"name":"ok"}\n',
		);
		const re = SessionStore.open(s.id, dir) as SessionStore;
		expect(re.name).toBe("ok");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect((re as unknown as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("open refuses ids that are not plain file names", () => {
		expect(SessionStore.open("../etc/passwd", dir)).toBeNull();
	});
});

describe("branch", () => {
	test("continues from an earlier entry and keeps the old branch in the tree", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		const q = s.append(user("q"));
		const a1 = s.append(asst("answer one"));
		s.branch(q);
		const a2 = s.append(asst("answer two"));

		expect(s.messages()).toEqual([user("q"), asst("answer two")]);
		expect(s.messages(a1)).toEqual([user("q"), asst("answer one")]);
		expect(s.leaves().map((e) => e.id)).toEqual([a1, a2]);
		const [root] = s.tree();
		expect(root.entry.id).toBe(q);
		expect(root.children.map((c) => c.entry.id)).toEqual([a1, a2]);

		// The leaf move survives a reopen.
		const re = SessionStore.open(s.id, dir) as SessionStore;
		expect(re.leafId).toBe(a2);
		re.branch(a1);
		expect(SessionStore.open(s.id, dir)?.messages()).toEqual([user("q"), asst("answer one")]);
	});

	test("a branch summary records what the abandoned branch did", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		const q = s.append(user("q"));
		const dead = s.append(asst("tried X, failed"));
		s.branch(q, { summary: "X does not work" });
		const ctx = s.messages();
		expect(ctx).toHaveLength(2);
		expect(String(ctx[1].content)).toContain("X does not work");
		const summary = s.getEntry(s.leafId as string);
		expect(summary).toMatchObject({ type: "branch_summary", fromId: dead, parentId: q });
	});

	test("branch(null) starts a fresh root in the same file", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		s.append(user("old"));
		s.branch(null);
		s.append(user("new"));
		expect(s.messages()).toEqual([user("new")]);
		expect(s.tree()).toHaveLength(2);
	});

	test("unknown entry id throws", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		expect(() => s.branch("nope")).toThrow();
	});
});

describe("fork", () => {
	test("copies root..entry into a new session that points back at its source", () => {
		const s = SessionStore.create({ cwd: "/work/a", model: "m1" }, dir);
		const q = s.append(user("q"));
		s.append(asst("a"));
		const f = s.fork(q, { name: "try again" });

		expect(f.id).not.toBe(s.id);
		expect(f.header.parentSession).toEqual({ id: s.id, entryId: q });
		expect(f.header.cwd).toBe(path.resolve("/work/a"));
		expect(f.model).toBe("m1");
		expect(f.messages()).toEqual([user("q")]);
		f.append(asst("b"));
		// The source is untouched.
		expect(SessionStore.open(s.id, dir)?.messages()).toEqual([user("q"), asst("a")]);
		expect(SessionStore.open(f.id, dir)?.messages()).toEqual([user("q"), asst("b")]);
	});

	test("fork() with no argument clones the current path", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		s.append(user("q"));
		s.append(asst("a"));
		expect(s.fork().messages()).toEqual(s.messages());
	});
});

describe("listSessions / latestSessionForCwd", () => {
	test("newest first, scoped by folder, empty sessions hidden", () => {
		const a = SessionStore.create({ cwd: "/work/a" }, dir);
		a.append(user("a"));
		touch(a.file, 60_000);
		const b = SessionStore.create({ cwd: "/work/b" }, dir);
		b.append(user("b"));
		touch(b.file, 30_000);
		const a2 = SessionStore.create({ cwd: "/work/a", name: "newer" }, dir);
		a2.append(user("a2"));
		SessionStore.create({ cwd: "/work/a" }, dir); // empty: never listed

		expect(listSessions({ sessionsDir: dir }).map((s) => s.id)).toEqual([a2.id, b.id, a.id]);
		expect(listSessions({ sessionsDir: dir, cwd: "/work/a" }).map((s) => s.id)).toEqual([
			a2.id,
			a.id,
		]);
		expect(listSessions({ sessionsDir: dir, includeEmpty: true })).toHaveLength(4);

		const latest = latestSessionForCwd("/work/a", dir);
		expect(latest).toMatchObject({ id: a2.id, name: "newer", messageCount: 1, format: "tree" });
		expect(latestSessionForCwd("/work/a/sub", dir)).toBeNull();
		expect(latestSessionForCwd("/work/a/", dir)?.id).toBe(a2.id);
	});

	test("message bodies that look like JSON do not inflate the count", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		s.append(user('{"type":"message","id":"x"} {"type":"session_info","name":"evil"}'));
		const [item] = listSessions({ sessionsDir: dir });
		expect(item.messageCount).toBe(1);
		expect(item.name).toBeUndefined();
	});

	test("older SessionManager .json sessions are listed too, and a tree copy wins", () => {
		const now = new Date().toISOString();
		const legacy = (id: string, cwd: string) =>
			fs.writeFileSync(
				path.join(dir, `${id}.json`),
				JSON.stringify({
					id,
					cwd,
					model: "m",
					provider: "p",
					messageCount: 2,
					createdAt: now,
					lastActiveAt: now,
					messages: [],
				}),
			);
		legacy("old1", "/work/a");
		const t = SessionStore.create({ cwd: "/work/a", id: "old2" }, dir);
		t.append(user("x"));
		legacy("old2", "/work/a");
		fs.writeFileSync(path.join(dir, "junk.json"), "{not json");

		const items = listSessions({ sessionsDir: dir, cwd: "/work/a" });
		expect(items.map((s) => [s.id, s.format]).sort()).toEqual([
			["old1", "legacy"],
			["old2", "tree"],
		]);
	});

	test("agent event logs in the parent folder are not mistaken for sessions", () => {
		fs.writeFileSync(path.join(dir, "abc.jsonl"), '{"type":"session_start"}\n');
		expect(listSessions({ sessionsDir: dir, includeEmpty: true })).toEqual([]);
		expect(fs.existsSync(treeDir(dir))).toBe(false);
	});
});
