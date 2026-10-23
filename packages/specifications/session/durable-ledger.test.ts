import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	interruptedCalls,
	ledgerPath,
	planResume,
	resolveInterrupted,
	resumeNotice,
	retryPrompt,
	setDurableEnabled,
	setDurableSession,
} from "./durable-ledger.js";
import { SessionWriter } from "./writer.js";

const READ_ONLY = new Set(["read_file", "list_files"]);
const isReadOnly = (t: string) => READ_ONLY.has(t);

let home: string;
const realHome = process.env.HOME;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "durable-"));
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = realHome;
	setDurableEnabled(false);
	setDurableSession(null);
	fs.rmSync(home, { recursive: true, force: true });
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	toolCallId: id,
	name,
	arguments: args,
	success: true,
	durationMs: 0,
});

describe("durable turns, slice 1", () => {
	test("a process SIGKILLed mid-write resumes with the write reported, not replayed", () => {
		const target = path.join(home, "notes.md");
		const child = path.join(home, "child.ts");
		// The child is a real 8gent session writer: it records the intent, does the
		// write, and is killed before the effect line, as Android kills Termux.
		fs.writeFileSync(
			child,
			`import * as fs from "node:fs";
import { SessionWriter } from ${JSON.stringify(path.join(import.meta.dir, "writer.ts"))};
import { setDurableEnabled, setDurableSession } from ${JSON.stringify(path.join(import.meta.dir, "durable-ledger.ts"))};
setDurableEnabled(true);
setDurableSession("s1");
const w = new SessionWriter("eight-1", ${JSON.stringify(path.join(home, "sessions"))});
w.writeUserMessage("add a line to notes.md");
w.writeToolCall(${JSON.stringify(call("c1", "read_file", { path: target }))});
w.writeToolResult("c1", true, "", 3, "read_file");
w.writeToolCall(${JSON.stringify(call("c2", "write_file", { path: target, content: "x" }))});
fs.appendFileSync(${JSON.stringify(target)}, "line\\n");
process.kill(process.pid, "SIGKILL");
w.writeToolResult("c2", true, "ok", 3, "write_file");
`,
		);
		const r = spawnSync(process.execPath, [child], { env: { ...process.env, HOME: home } });
		expect(r.signal).toBe("SIGKILL");
		expect(fs.readFileSync(target, "utf8")).toBe("line\n");

		// Resume in a new process (this one): only the cut-off write is open.
		const open = interruptedCalls("s1");
		expect(open.map((c) => c.tool)).toEqual(["write_file"]);
		expect(open[0].key).toBe("s1:c2");
		const plan = planResume(open, isReadOnly);
		expect(plan.askPerson).toHaveLength(1);
		expect(plan.rerunSafe).toHaveLength(0);
		const notice = resumeNotice(plan) ?? "";
		expect(notice).toContain(`write_file ${target}`);
		expect(notice).toContain("may or may not have happened");
		expect(notice).toContain("/durable retry");
		expect(notice).toContain("/durable skip");
		// Resuming ran nothing: the write happened exactly once.
		expect(fs.readFileSync(target, "utf8")).toBe("line\n");
	});

	test("retry hands 8gent the ledger summary, check first, and closes the call", () => {
		setDurableEnabled(true);
		setDurableSession("s2");
		const w = new SessionWriter("eight-2", path.join(home, "sessions"));
		w.writeUserMessage("go");
		w.writeToolCall(call("a", "run_command", { command: "git push" }));
		w.writeToolCall(call("b", "list_files", { path: "src" }));
		const plan = planResume(interruptedCalls("s2"), isReadOnly);
		expect(plan.rerunSafe.map((c) => c.tool)).toEqual(["list_files"]);
		const prompt = retryPrompt(plan);
		expect(prompt).toContain("run_command git push (may or may not have happened)");
		expect(prompt).toContain("Check the current state first");
		expect(prompt).toContain("Do not repeat a change that already landed");
		expect(resolveInterrupted("s2", "retry")).toBe(2);
		expect(interruptedCalls("s2")).toEqual([]);
	});

	test("skip closes the call, so a second resume asks nothing", () => {
		setDurableEnabled(true);
		setDurableSession("s3");
		const w = new SessionWriter("eight-3", path.join(home, "sessions"));
		w.writeToolCall(call("a", "edit_file", { path: "x.ts" }));
		expect(resolveInterrupted("s3", "skip")).toBe(1);
		expect(resumeNotice(planResume(interruptedCalls("s3"), isReadOnly))).toBeNull();
	});

	test("an error result closes the call; a torn last line does not hide earlier ones", () => {
		setDurableEnabled(true);
		setDurableSession("s4");
		const w = new SessionWriter("eight-4", path.join(home, "sessions"));
		w.writeToolCall(call("a", "write_file", { path: "a" }));
		w.writeToolError("a", "write_file", "denied");
		w.writeToolCall(call("b", "write_file", { path: "b" }));
		fs.appendFileSync(ledgerPath("s4"), '{"k":"effect","id":"b"');
		expect(interruptedCalls("s4").map((c) => c.hint)).toEqual(["b"]);
	});

	test("off by default and without a session: no ledger is written", () => {
		const w = new SessionWriter("eight-5", path.join(home, "sessions"));
		setDurableSession("s5");
		w.writeToolCall(call("a", "write_file", { path: "a" }));
		expect(fs.existsSync(ledgerPath("s5"))).toBe(false);
		setDurableEnabled(true);
		setDurableSession(null);
		w.writeToolCall(call("b", "write_file", { path: "b" }));
		expect(fs.existsSync(path.join(home, ".8gent", "sessions", "durable"))).toBe(false);
	});
});
