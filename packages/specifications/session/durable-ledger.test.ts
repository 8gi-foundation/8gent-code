import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendRecord,
	closeTurn,
	continuePrompt,
	cutOffNotice,
	flushText,
	hintOf,
	interruptedCalls,
	isCutOffError,
	lastTurn,
	ledgerPath,
	noteStreamText,
	noteTurnEnd,
	planResume,
	resolveInterrupted,
	resumeNotice,
	retryPrompt,
	setDurableEnabled,
	setDurableSession,
	turnSummaryPath,
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

describe("durable ledger hardening (#4805 review)", () => {
	test("a Bearer header and a ?token= URL never reach the ledger or the retry prompt", () => {
		setDurableEnabled(true);
		setDurableSession("s6");
		const w = new SessionWriter("eight-6", path.join(home, "sessions"));
		const bearer = "abcdefghijklmnopqrstuvwxyz0123456789";
		w.writeToolCall(
			call("a", "run_command", {
				command: `curl -H "Authorization: Bearer ${bearer}" https://api.x.dev/v1`,
			}),
		);
		w.writeToolCall(
			call("b", "web_fetch", { url: "https://u:pw123@api.x.dev/data?token=t0k3n&id=1" }),
		);
		const raw = fs.readFileSync(ledgerPath("s6"), "utf8");
		const prompt = retryPrompt(planResume(interruptedCalls("s6"), isReadOnly));
		for (const text of [raw, prompt]) {
			expect(text).not.toContain(bearer);
			expect(text).not.toContain("t0k3n");
			expect(text).not.toContain("pw123");
		}
		expect(prompt).toContain("https://api.x.dev/data?...");
		expect(hintOf({ path: "src/app.ts" })).toBe("src/app.ts");
	});

	test("a planted symlink is refused, not followed", () => {
		const victim = path.join(home, "victim.txt");
		fs.writeFileSync(victim, "keep\n");
		fs.mkdirSync(path.dirname(ledgerPath("s7")), { recursive: true });
		fs.symlinkSync(victim, ledgerPath("s7"));
		expect(() => appendRecord("s7", { k: "turn", at: "now" })).toThrow();
		expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
		expect(interruptedCalls("s7")).toEqual([]);
	});

	test("an existing ledger and folder are made private", () => {
		const file = ledgerPath("s8");
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
		fs.chmodSync(path.dirname(file), 0o755);
		fs.writeFileSync(file, "", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		appendRecord("s8", { k: "turn", at: "now" });
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
	});
});

describe("durable turns, slice 2: a turn cut off with no tool running", () => {
	test("SIGKILL mid-stream resumes with the partial text kept and no finished call repeated", () => {
		const target = path.join(home, "notes.md");
		const child = path.join(home, "child2.ts");
		const dir = JSON.stringify(import.meta.dir);
		// A real session writer and the real streamed-reply reader: the write finishes,
		// step 0's text lands, step 1 streams over SSE and the process is killed mid-stream.
		fs.writeFileSync(
			child,
			`import * as fs from "node:fs";
import * as path from "node:path";
const dir = ${dir};
const { SessionWriter } = await import(path.join(dir, "writer.ts"));
const { setDurableEnabled, setDurableSession, TEXT_FLUSH_MS } = await import(path.join(dir, "durable-ledger.ts"));
const { readStreamedChatCompletion } = await import(path.join(dir, "../../ai/text-tool-endpoint.ts"));
setDurableEnabled(true);
setDurableSession("s2");
const w = new SessionWriter("eight-2", ${JSON.stringify(path.join(home, "sessions"))});
w.writeUserMessage("add a line to notes.md and tell me what it holds");
w.writeToolCall(${JSON.stringify(call("c1", "write_file", { path: target, content: "line" }))});
fs.appendFileSync(${JSON.stringify(target)}, "line\\n");
w.writeToolResult("c1", true, "ok", 3, "write_file");
w.writeAssistantContent(0, [{ type: "text", text: "Wrote the line." }]);
const enc = new TextEncoder();
const frame = (t) => enc.encode("data: " + JSON.stringify({ choices: [{ delta: { content: t } }] }) + "\\n\\n");
const body = new ReadableStream({
	async start(c) {
		c.enqueue(frame("notes.md now holds "));
		c.enqueue(frame("one line"));
		await Bun.sleep(TEXT_FLUSH_MS + 150);
		process.kill(process.pid, "SIGKILL"); // the phone kills Termux mid-stream
	},
});
await readStreamedChatCompletion(new Response(body));
`,
		);
		const r = spawnSync(process.execPath, [child], { env: { ...process.env, HOME: home } });
		expect(r.signal).toBe("SIGKILL");

		const turn = lastTurn("s2");
		expect(turn).not.toBeNull();
		if (!turn) return;
		expect(turn.msg).toContain("add a line to notes.md");
		expect(turn.partial).toBe("Wrote the line.\n\nnotes.md now holds one line");
		expect(turn.finished).toEqual([{ tool: "write_file", hint: target, ok: true }]);
		expect(turn.open).toEqual([]);

		// The summary was written temp-then-rename and says the turn is open.
		const summary = JSON.parse(fs.readFileSync(turnSummaryPath("s2"), "utf8"));
		expect(summary.open).toBe(true);
		expect(summary.turn.finished).toHaveLength(1);
		expect(
			fs.readdirSync(path.dirname(turnSummaryPath("s2"))).some((f) => f.endsWith(".tmp")),
		).toBe(false);

		const notice = cutOffNotice(turn) ?? "";
		expect(notice).toContain("notes.md now holds one line");
		expect(notice).toContain("/durable continue");

		// Continue: the request is re-sent with the partial text kept and the
		// finished write named as done, so it is not run again.
		const prompt = continuePrompt(turn, isReadOnly);
		expect(prompt).toContain("add a line to notes.md");
		expect(prompt).toContain("Wrote the line.\n\nnotes.md now holds one line");
		expect(prompt).toContain("Do not run them again");
		expect(prompt).toContain(`write_file ${target} (ok)`);
		expect(prompt).not.toContain("may or may not have happened");
		closeTurn("s2", "continue");
		expect(lastTurn("s2")).toBeNull();
		expect(interruptedCalls("s2")).toEqual([]);
		expect(fs.readFileSync(target, "utf8")).toBe("line\n");
		expect(JSON.parse(fs.readFileSync(turnSummaryPath("s2"), "utf8")).open).toBe(false);
	});

	test("a killed model call with nothing streamed still offers continue with the request", () => {
		setDurableEnabled(true);
		setDurableSession("s3");
		const w = new SessionWriter("eight-3", path.join(home, "sessions"));
		w.writeUserMessage("explain the build");
		const turn = lastTurn("s3");
		expect(turn?.partial).toBe("");
		expect(continuePrompt(turn!, isReadOnly)).toContain("explain the build");
	});

	test("a finished turn offers nothing on resume", () => {
		setDurableEnabled(true);
		setDurableSession("s4");
		const w = new SessionWriter("eight-4", path.join(home, "sessions"));
		w.writeUserMessage("hi");
		w.writeAssistantContent(0, [{ type: "text", text: "hello" }]);
		noteTurnEnd();
		expect(lastTurn("s4")).toBeNull();
		expect(cutOffNotice(lastTurn("s4"))).toBeNull();
	});

	test("a symlinked sessions folder is refused", () => {
		const elsewhere = path.join(home, "elsewhere");
		fs.mkdirSync(elsewhere);
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		fs.symlinkSync(elsewhere, path.join(home, ".8gent", "sessions"));
		expect(() => appendRecord("s5", { k: "turn", at: "now" })).toThrow(/symlink refused/);
		expect(fs.readdirSync(elsewhere)).toEqual([]);
	});

	test("a Bearer token streamed in two pieces never reaches disk or the continue prompt", () => {
		setDurableEnabled(true);
		setDurableSession("s6");
		const w = new SessionWriter("eight-6", path.join(home, "sessions"));
		const tok = "abcdefghijklmnop0123456789qrstuv";
		w.writeUserMessage("call the api");
		w.writeAssistantContent(0, [{ type: "text", text: `Using Authorization: Bearer ${tok} now.` }]);
		noteStreamText("Retrying with Bearer abcdefghij");
		noteStreamText("klmnop0123456789qrstuv and waiting.");
		flushText();
		const dir = path.dirname(ledgerPath("s6"));
		for (const f of fs.readdirSync(dir)) {
			const text = fs.readFileSync(path.join(dir, f), "utf8");
			expect(text).not.toContain(tok);
			expect(text).not.toContain("klmnop0123456789qrstuv");
			expect(text).not.toContain("Bearer abcdefghij");
		}
		const turn = lastTurn("s6");
		expect(turn?.partial).toContain("and waiting.");
		const prompt = continuePrompt(turn!, isReadOnly);
		expect(prompt).not.toContain(tok);
		expect(prompt).not.toContain("klmnop0123456789qrstuv");
	});

	test("dropped connections cut a turn off; a stop by the person ends it", () => {
		expect(isCutOffError(new TypeError("fetch failed"))).toBe(true);
		expect(isCutOffError(Object.assign(new Error("read"), { code: "ECONNRESET" }))).toBe(true);
		expect(isCutOffError(new Error("stream ended before [DONE] or a finish_reason"))).toBe(true);
		expect(isCutOffError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(false);
		expect(isCutOffError(new Error("400 invalid model"))).toBe(false);
	});
});
