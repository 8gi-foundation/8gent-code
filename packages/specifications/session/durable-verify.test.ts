import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunSessionStore } from "../../eight/run-session.js";
import { parseRunArgs, runRunCommand } from "../../eight/run.js";
import {
	appendRecord,
	interruptedCalls,
	readLedger,
	setDurableEnabled,
	setDurableSession,
} from "./durable-ledger.js";
import {
	DURABLE_EXIT,
	buildSignature,
	durableResumeNotice,
	headlessDurableGate,
	setDurableRoot,
} from "./durable-verify.js";
import { SessionWriter } from "./writer.js";

const isReadOnly = (t: string) => t === "read_file";
const RO: ReadonlySet<string> = new Set(["read_file"]);

let home: string;
let work: string;
const realHome = process.env.HOME;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "durable3-"));
	work = path.join(home, "work");
	fs.mkdirSync(work);
	process.env.HOME = home;
	setDurableEnabled(true);
	setDurableSession("s3");
	setDurableRoot(work);
});
afterEach(() => {
	process.env.HOME = realHome;
	setDurableEnabled(false);
	setDurableSession(null);
	setDurableRoot(null);
	fs.rmSync(home, { recursive: true, force: true });
});

/** The real tap: SessionWriter writes the intent, as the 8gent loops do before a tool runs. */
function startCall(id: string, name: string, args: Record<string, unknown>) {
	const w = new SessionWriter("eight-3", path.join(home, "sessions"));
	w.writeUserMessage("do the thing");
	w.writeToolCall({ toolCallId: id, name, arguments: args, success: true, durationMs: 0 });
	// Killed here: no tool_result reaches the ledger.
}

const git = (...a: string[]) =>
	spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], {
		cwd: work,
		encoding: "utf8",
	});

describe("durable turns, slice 3: verified effects", () => {
	test("a write that already landed is closed, not redone; one that did not is asked", () => {
		startCall("w1", "write_file", { path: "notes.md", content: "hello\n" });
		startCall("w2", "write_file", { path: "other.md", content: "never written\n" });
		fs.writeFileSync(path.join(work, "notes.md"), "hello\n"); // w1 landed before the kill

		const notice = durableResumeNotice("s3", isReadOnly) ?? "";
		expect(notice).toContain("Already done, not redone: write_file notes.md");
		expect(notice).toContain("write_file other.md (started");
		expect(interruptedCalls("s3").map((c) => c.id)).toEqual(["w2"]);
		const closed = readLedger("s3").filter((r) => r.k === "resolve");
		expect(closed).toEqual([expect.objectContaining({ id: "w1", how: "verified" })]);
		// A second resume asks nothing about w1.
		expect(durableResumeNotice("s3", isReadOnly) ?? "").not.toContain("notes.md");
	});

	test("an edit is done only when the file holds the edited content", () => {
		const f = path.join(work, "a.ts");
		fs.writeFileSync(f, "const x = 1;\nconst y = 2;\n");
		startCall("e1", "edit_file", { path: "a.ts", oldText: "x = 1", newText: "x = 10" });
		expect(durableResumeNotice("s3", isReadOnly) ?? "").toContain("may or may not have happened");
		expect(interruptedCalls("s3")).toHaveLength(1);

		fs.writeFileSync(f, "const x = 10;\nconst y = 2;\n");
		expect(durableResumeNotice("s3", isReadOnly)).toBe("Already done, not redone: edit_file a.ts.");
		expect(interruptedCalls("s3")).toHaveLength(0);
	});

	test("a commit that already exists on HEAD is closed, not redone", () => {
		git("init", "-q");
		fs.writeFileSync(path.join(work, "a.txt"), "1\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "first");
		fs.writeFileSync(path.join(work, "a.txt"), "2\n");
		git("add", "a.txt");
		startCall("g1", "git_commit", { message: "second  \n" });

		// Not committed yet: the person is asked.
		expect(headlessDurableGate("s3", { retry: false, skip: false }, RO).exit).toBe(DURABLE_EXIT);
		expect(interruptedCalls("s3")).toHaveLength(1);

		expect(git("commit", "-q", "-m", "second  \n").status).toBe(0);
		const gate = headlessDurableGate("s3", { retry: false, skip: false }, RO);
		expect(gate.exit).toBeUndefined();
		expect(gate.text).toEqual(["[durable] already done, not redone: git_commit"]);
		expect(interruptedCalls("s3")).toHaveLength(0);
	});

	test("a commit with the same message on another tree is not taken as done", () => {
		git("init", "-q");
		fs.writeFileSync(path.join(work, "a.txt"), "1\n");
		git("add", "a.txt");
		startCall("g2", "git_commit", { message: "add a" });
		fs.writeFileSync(path.join(work, "a.txt"), "changed\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "add a");
		expect(headlessDurableGate("s3", { retry: false, skip: false }, RO).exit).toBe(DURABLE_EXIT);
	});

	test("paths outside the project are never read: absolute, ../ and a symlinked folder", () => {
		const outside = path.join(home, "outside.md");
		fs.writeFileSync(outside, "secret\n");
		fs.symlinkSync(home, path.join(work, "link"));
		startCall("o1", "write_file", { path: outside, content: "secret\n" });
		startCall("o2", "write_file", { path: "../outside.md", content: "secret\n" });
		startCall("o3", "write_file", { path: "link/outside.md", content: "secret\n" });
		startCall("o4", "edit_file", { path: "link/outside.md", oldText: "secret", newText: "x" });
		const intents = readLedger("s3").filter((r) => r.k === "intent");
		for (const r of intents) expect(r.k === "intent" && r.check).toBeUndefined();
		// The content matches, but nothing outside the root counts as done: all four are asked.
		durableResumeNotice("s3", isReadOnly);
		expect(interruptedCalls("s3").map((c) => c.id)).toEqual(["o1", "o2", "o3", "o4"]);
	});

	test("a git_commit intent writes no object into the repository", () => {
		git("init", "-q");
		fs.writeFileSync(path.join(work, "a.txt"), "1\n");
		git("add", "a.txt");
		const objects = () =>
			fs
				.readdirSync(path.join(work, ".git", "objects"), { recursive: true })
				.filter((f) => /^[0-9a-f]{2}[/\\][0-9a-f]{38}$/.test(String(f))).length;
		const before = objects();
		startCall("g3", "git_commit", { message: "add a" });
		expect(objects()).toBe(before);
		const intent = readLedger("s3").find((r) => r.k === "intent");
		expect(intent && intent.k === "intent" && intent.check?.t).toBe("commit");
	});

	test("command tools are always asked and never retried, even under --durable-retry", () => {
		startCall("r1", "run_command", { command: "touch made.txt" });
		startCall("b1", "background_start", { command: "npm run dev" });
		startCall("w3", "write_file", { path: "b.md", content: "b\n" });
		expect(durableResumeNotice("s3", isReadOnly) ?? "").toContain("run_command touch made.txt");

		const gate = headlessDurableGate("s3", { retry: true, skip: false }, RO);
		expect(gate.exit).toBeUndefined();
		expect(gate.preamble).toContain("- write_file b.md (may or may not have happened)");
		expect(gate.preamble).toContain(
			"- run_command touch made.txt (not redone: do not run it again)",
		);
		const how = Object.fromEntries(
			readLedger("s3").flatMap((r) => (r.k === "resolve" ? [[r.id, r.how]] : [])),
		);
		expect(how).toEqual({ r1: "skip", b1: "skip", w3: "retry" });
		expect(gate.preamble).toContain(
			"- background_start npm run dev (not redone: do not run it again)",
		);
		// The retry run may only read and use the tools resume can verify.
		expect(gate.allow).toEqual(["read_file", "write_file", "edit_file", "git_commit"]);
	});

	test("a call started by another build is flagged before any retry", () => {
		startCall("w4", "write_file", { path: "c.md", content: "c\n" });
		const intent = readLedger("s3").find((r) => r.k === "intent");
		expect(intent && intent.k === "intent" && intent.build).toBe(buildSignature());
		appendRecord("s3", {
			k: "intent",
			id: "w5",
			tool: "write_file",
			argsHash: "0",
			key: "s3:w5",
			hint: "d.md",
			build: "0.0.1+deadbeef0000",
			at: new Date().toISOString(),
		});
		const notice = durableResumeNotice("s3", isReadOnly) ?? "";
		const flag = `These calls were started by 8gent 0.0.1+deadbeef0000; this is ${buildSignature()}.`;
		expect(notice.split("\n")[0]).toContain(flag);
		expect(notice.indexOf(flag)).toBeLessThan(notice.indexOf("/durable retry"));
		expect(headlessDurableGate("s3", { retry: false, skip: false }, RO).text.join("\n")).toContain(
			flag,
		);
	});

	test("headless resume prints the interrupted calls and exits non-zero without a flag", async () => {
		startCall("w6", "write_file", { path: "e.md", content: "e\n" });
		startCall("r2", "run_command", { command: "npm publish" });
		setDurableEnabled(false);
		const sessions: RunSessionStore = {
			list: () => [],
			latestForCwd: () => null,
			load: () => null,
			save: () => {},
		} as unknown as RunSessionStore;
		const err: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((s: string) => {
			err.push(String(s));
			return true;
		}) as typeof process.stderr.write;
		let code: number;
		try {
			code = await runRunCommand(["-p", "--resume", "s3", "--cwd", work, "carry on"], {
				sessions,
				stdin: async () => "",
			});
		} finally {
			process.stderr.write = write;
		}
		expect(code).toBe(DURABLE_EXIT);
		const out = err.join("");
		expect(out).toContain("[durable]   write_file e.md (started");
		expect(out).toContain("[durable]   run_command npm publish (started");
		expect(out).toContain("Pass --durable-retry");
		// Nothing was resolved: the next run asks again.
		expect(interruptedCalls("s3")).toHaveLength(2);

		const skip = headlessDurableGate("s3", { retry: false, skip: true }, RO);
		expect(skip.exit).toBeUndefined();
		expect(interruptedCalls("s3")).toHaveLength(0);
	});

	test("--resume <id> names a session; --durable-retry and --durable-skip parse", () => {
		const a = parseRunArgs(["-p", "--resume", "run-1", "--durable-retry", "go"]);
		expect(a.session).toBe("run-1");
		expect(a.durableRetry).toBe(true);
		expect(a.prompt).toBe("go");
		expect(parseRunArgs(["-p", "--resume=run-2", "--durable-skip", "x"]).durableSkip).toBe(true);
		expect(parseRunArgs(["-p", "x", "--resume"]).continueLatest).toBe(true);
	});
});
