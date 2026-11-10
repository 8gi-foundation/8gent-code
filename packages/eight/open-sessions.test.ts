import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type RestoreIo,
	currentBootAt,
	markClosed,
	markOpen,
	offerRestore,
	restorableSessions,
} from "./open-sessions";
import { SessionManager } from "./session-manager";

let dir: string;
beforeEach(() => {
	saveCount = 0;
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-sessions-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A pid that belonged to a real process and has exited: what a quit or a restart leaves behind. */
function deadPid(): number {
	const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
	return Number(r.stdout.toString());
}

let saveCount = 0;
/** A session through the same SessionManager the TUI saves with. */
function saved(cwd: string, ...prompts: string[]) {
	const msAgo = (saveCount++ ? 0 : 60_000);
	const mgr = new SessionManager(dir);
	const s = mgr.create({ cwd, model: "m", provider: "ollama" });
	mgr.save(
		s.id,
		prompts.flatMap((p) => [
			{ role: "user", content: p },
			{ role: "assistant", content: `done: ${p}` },
		]),
	);
	// First saved is older: recency order must not depend on the clock tick.
	const file = path.join(dir, "tree", `${s.id}.jsonl`);
	const t = new Date(Date.now() - msAgo);
	fs.utimesSync(file, t, t);
	return s.id;
}

const io = (answers: string[], interactive = true) => {
	const lines: string[] = [];
	const asked: string[] = [];
	const i: RestoreIo = {
		interactive,
		write: (l) => lines.push(l),
		ask: async (q) => {
			asked.push(q);
			return answers.shift() ?? "";
		},
	};
	return { i, lines, asked };
};

describe("open-session record", () => {
	test("a session whose process is gone is listed with folder, last activity and last user message", () => {
		const id = saved("/work/a", "first question", "fix the login bug");
		markOpen(id, { dir, pid: deadPid() });
		const got = restorableSessions({ dir });
		expect(got).toHaveLength(1);
		expect(got[0].id).toBe(id);
		expect(got[0].cwd).toBe("/work/a");
		expect(got[0].lastUserMessage).toBe("fix the login bug");
		expect(Date.parse(got[0].lastActiveAt)).toBeGreaterThan(0);
	});

	test("a session held by a live process is not listed", () => {
		markOpen(saved("/work/a", "hi"), { dir });
		expect(restorableSessions({ dir })).toEqual([]);
	});

	test("a deliberate quit leaves nothing to restore", () => {
		const pid = deadPid();
		markOpen(saved("/work/a", "hi"), { dir, pid });
		markClosed({ dir, pid });
		expect(restorableSessions({ dir })).toEqual([]);
	});

	test("after a Mac restart a reused pid is not mistaken for the old process", () => {
		const id = saved("/work/a", "hi");
		// pid is alive (this test process) but the record is from an earlier boot
		markOpen(id, { dir, bootAt: currentBootAt() - 3600 });
		expect(restorableSessions({ dir }).map((s) => s.id)).toEqual([id]);
	});

	test("a session with no messages is not offered", () => {
		const mgr = new SessionManager(dir);
		markOpen(mgr.create({ cwd: "/work/a" }).id, { dir, pid: deadPid() });
		expect(restorableSessions({ dir })).toEqual([]);
	});

	test("a corrupt record is ignored and removed", () => {
		fs.mkdirSync(path.join(dir, "open"), { recursive: true });
		fs.writeFileSync(path.join(dir, "open", "1.json"), "{nope");
		expect(restorableSessions({ dir })).toEqual([]);
		expect(fs.existsSync(path.join(dir, "open", "1.json"))).toBe(false);
	});
});

describe("offerRestore", () => {
	const two = () => {
		const a = saved("/work/a", "alpha");
		const b = saved("/work/b", "beta");
		markOpen(a, { dir, pid: deadPid() });
		markOpen(b, { dir, pid: deadPid() });
		return { a, b };
	};

	test("unattended: nothing is asked, nothing resumes, the record is kept for the next real start", async () => {
		two();
		const t = io(["y", "y"], false);
		expect(await offerRestore(t.i, { dir })).toEqual([]);
		expect(t.asked).toEqual([]);
		expect(restorableSessions({ dir })).toHaveLength(2);
	});

	test("an empty answer is No: nothing resumes, and the person is not asked again", async () => {
		two();
		const t = io(["", ""]);
		expect(await offerRestore(t.i, { dir })).toEqual([]);
		expect(t.lines[0]).toBe("2 sessions were open when 8gent Code last stopped:");
		expect(restorableSessions({ dir })).toEqual([]);
	});

	test("yes for one returns only that one", async () => {
		const { a, b } = two();
		// newest first: b was saved after a
		const t = io(["n", "y"]);
		const got = await offerRestore(t.i, { dir });
		expect(got.map((s) => s.id)).toEqual([a]);
		expect(got[0].cwd).toBe("/work/a");
		expect(t.lines.join("\n")).toContain(b);
	});

	test("nothing open: silent", async () => {
		const t = io([]);
		expect(await offerRestore(t.i, { dir })).toEqual([]);
		expect(t.lines).toEqual([]);
	});
});
