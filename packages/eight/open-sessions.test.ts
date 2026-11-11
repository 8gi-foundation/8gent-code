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
	finishRestore,
	offerRestore,
	restoreOnStart,
	reopenCommand,
	shellQuote,
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

describe("what is printed from a session record (#199 read)", () => {
	const shown = async (cwd: string, ...prompts: string[]) => {
		const id = saved(cwd, ...prompts);
		markOpen(id, { dir, pid: deadPid() });
		const t = io(["n"]);
		await offerRestore(t.i, { dir });
		return { id, text: t.lines.join("\n"), asked: t.asked.join("") };
	};

	test("ESC and other control bytes in the last message never reach the screen", async () => {
		const r = await shown("/work/a", "hi\x1b[2J\x1b]0;forged\x07\x1b[31m there\r\x08\x00");
		expect(r.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		expect(r.text).toContain("hi");
	});

	test("a secret in the last message is redacted, even with an escape byte inside it", async () => {
		const r = await shown(
			"/work/a",
			`use sk-ant-abcdefghijklmnopqrstuvwxyz012345 and ghp_${"a".repeat(36)} and sk-ant-abcdefghij\x1b[0mklmnopqrstuvwxyz`,
		);
		expect(r.text).not.toContain("ghp_aaaa");
		expect(r.text).not.toContain("abcdefghij");
		expect(r.text).toContain("REDACTED");
	});

	test("the preview is short", async () => {
		const r = await shown("/work/a", "x ".repeat(500));
		expect(r.text.length).toBeLessThan(400);
	});

	test("the prompt says the folder changes", async () => {
		expect((await shown("/work/a", "hi")).asked).toContain("open it in that folder");
	});

	test("a folder name with control bytes is not printed", async () => {
		const r = await shown("/work/\x1b[2Jevil", "hi");
		expect(r.text).not.toContain("\x1b");
		expect(r.text).toContain("folder name not shown");
	});
});

describe("printed reopen command", () => {
	test("a hostile folder name stays one quoted word", () => {
		const cwd = "/tmp/a b; touch pwned $(id) `id` it's";
		const cmd = reopenCommand({ id: "abc123", cwd });
		expect(cmd.endsWith(" && 8gent --resume abc123")).toBe(true);
		// run the printed folder word through a real shell: it must come back as exactly the folder
		const word = cmd.slice("cd ".length, -" && 8gent --resume abc123".length);
		const r = spawnSync("sh", ["-c", `printf %s ${word}`]);
		expect(r.stdout.toString()).toBe(cwd);
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	test("a folder with a newline or escape drops the cd and keeps the id", () => {
		expect(reopenCommand({ id: "abc123", cwd: "/x\n; touch pwned" })).toBe("8gent --resume abc123");
	});
});

describe("stale records", () => {
	test("same-boot pid reuse by a live stranger is never offered (fails safe)", () => {
		markOpen(saved("/work/a", "hi"), { dir, pid: process.pid });
		expect(restorableSessions({ dir })).toEqual([]);
	});

	test("a record older than 30 days is not offered and is forgotten", async () => {
		const id = saved("/work/a", "hi");
		const pid = deadPid();
		markOpen(id, { dir, pid });
		const f = path.join(dir, "open", `${pid}.json`);
		const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
		fs.utimesSync(f, old, old);
		expect(restorableSessions({ dir })).toEqual([]);
		await offerRestore(io([]).i, { dir });
		expect(fs.existsSync(f)).toBe(false);
	});
});

describe("restoreOnStart (the call index.tsx makes)", () => {
	const launch = process.cwd();
	afterEach(() => process.chdir(launch));
	const open = (cwd: string, prompts = ["hi"]) => {
		const id = saved(cwd, ...prompts);
		markOpen(id, { dir, pid: deadPid() });
		return id;
	};

	test("yes: enters the folder, resumes it, and the record goes only when the resumed session is opened", async () => {
		const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "work-")));
		const id = open(work);
		const t = io(["y"]);
		const r = await restoreOnStart(t.i, { dir });
		expect(r.sessionResume).toBe(id);
		expect(process.cwd()).toBe(work);
		expect(restorableSessions({ dir }).map((s) => s.id)).toEqual([id]); // still listed: resume not yet done
		markOpen(id, { dir }); // what the app does once the session is active
		expect(restorableSessions({ dir })).toEqual([]);
		fs.rmSync(work, { recursive: true, force: true });
	});

	test("a folder that became a file: no crash, says so, not resumed, still offered next start", async () => {
		const f = path.join(dir, "now-a-file");
		fs.writeFileSync(f, "x");
		const id = open(f);
		const t = io(["y"]);
		const r = await restoreOnStart(t.i, { dir });
		expect(r.sessionResume).toBeUndefined();
		expect(process.cwd()).toBe(launch);
		expect(t.lines.join("\n")).toContain("Not resumed");
		expect(restorableSessions({ dir }).map((s) => s.id)).toEqual([id]);
	});

	test("a missing folder: says it no longer exists, not resumed, kept", async () => {
		const id = open(path.join(dir, "gone"));
		const t = io(["y"]);
		const r = await restoreOnStart(t.i, { dir });
		expect(r.sessionResume).toBeUndefined();
		expect(t.lines.join("\n")).toContain("no longer exists");
		expect(restorableSessions({ dir }).map((s) => s.id)).toEqual([id]);
	});

	test("an unreadable folder: no crash, not resumed", async () => {
		const locked = path.join(dir, "locked");
		fs.mkdirSync(locked);
		fs.chmodSync(locked, 0o000);
		try {
			open(locked);
			const r = await restoreOnStart(io(["y"]).i, { dir });
			if (process.getuid?.() !== 0) expect(r.sessionResume).toBeUndefined();
			expect(process.cwd()).toBe(process.getuid?.() === 0 ? locked : launch);
		} finally {
			fs.chmodSync(locked, 0o700);
		}
	});

	test("a folder whose name was not shown is not entered; resumes where launched, and says so", async () => {
		const odd = path.join(dir, "odd\x1b[2J");
		fs.mkdirSync(odd);
		const id = open(odd);
		const t = io(["y"]);
		const r = await restoreOnStart(t.i, { dir });
		expect(r.sessionResume).toBe(id);
		expect(process.cwd()).toBe(launch);
		expect(t.lines.join("\n")).toContain("could not be shown");
		expect(t.lines.join("\n")).not.toContain("\x1b");
	});

	test("nobody answers: the question times out to No, says so, and nothing is forgotten", async () => {
		const id = open("/work/a");
		const t = io([]);
		t.i.ask = () => new Promise<string>(() => {});
		t.i.timeoutMs = 30;
		const r = await restoreOnStart(t.i, { dir });
		expect(r).toEqual({ later: [] });
		expect(t.lines.join("\n")).toContain("No answer in");
		expect(restorableSessions({ dir }).map((s) => s.id)).toEqual([id]);
	});

	test("a second yes is shown after exit, then forgotten", async () => {
		const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "work-")));
		const a = open("/work/a"); // older
		const b = open(work);
		const r = await restoreOnStart(io(["y", "y"]).i, { dir });
		expect(r.sessionResume).toBe(b);
		expect(r.later.map((s) => s.id)).toEqual([a]);
		const out: string[] = [];
		finishRestore(r.later, (l) => out.push(l), { dir });
		expect(out[0]).toContain(`8gent --resume ${a}`);
		markOpen(b, { dir });
		expect(restorableSessions({ dir })).toEqual([]);
		fs.rmSync(work, { recursive: true, force: true });
	});
});
