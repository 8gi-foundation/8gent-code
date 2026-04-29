/**
 * Tests for tmux-session — orchestration backend that lets 8gent
 * spawn, drive, and read from external CLI sessions running in real
 * Terminal.app windows.
 *
 * Pure command-builder tests run by default. The live tmux integration
 * test runs only when TMUX_INTEGRATION=1 and tmux is on PATH.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPipePaneArgs,
	buildSendKeysArgs,
	buildTmuxNewSessionArgs,
	hasSession,
	killTmuxSession,
	parseLogTail,
	readSessionLog,
	sendKeys,
	spawnTmuxSession,
} from "./tmux-session.js";

const tmuxAvailable = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const live = tmuxAvailable && process.env.TMUX_INTEGRATION === "1";

describe("buildTmuxNewSessionArgs", () => {
	it("builds detached new-session with size and command", () => {
		const args = buildTmuxNewSessionArgs({
			sessionId: "term-abc",
			command: "claude",
			cmdArgs: [],
			cwd: "/Users/me",
			cols: 200,
			rows: 50,
		});
		expect(args).toContain("new-session");
		expect(args).toContain("-d");
		expect(args).toContain("-s");
		expect(args).toContain("term-abc");
		expect(args).toContain("-x");
		expect(args).toContain("200");
		expect(args).toContain("-y");
		expect(args).toContain("50");
		expect(args).toContain("-c");
		expect(args).toContain("/Users/me");
		expect(args[args.length - 1]).toBe("claude");
	});

	it("appends shell-quoted args when cmdArgs is non-empty", () => {
		const args = buildTmuxNewSessionArgs({
			sessionId: "term-x",
			command: "/bin/sh",
			cmdArgs: ["-c", "echo hi"],
			cwd: "/tmp",
		});
		// Final element is a single shell string with the args glued in.
		const last = args[args.length - 1];
		expect(last).toContain("/bin/sh");
		expect(last).toContain("'-c'");
		expect(last).toContain("'echo hi'");
	});
});

describe("buildSendKeysArgs", () => {
	it("appends Enter at the end of the keys", () => {
		const args = buildSendKeysArgs("term-x", "hello world");
		expect(args).toEqual(["send-keys", "-t", "term-x", "hello world", "Enter"]);
	});

	it("supports raw mode that does not append Enter", () => {
		const args = buildSendKeysArgs("term-x", "hello", { appendEnter: false });
		expect(args).toEqual(["send-keys", "-t", "term-x", "hello"]);
	});
});

describe("buildPipePaneArgs", () => {
	it("builds pipe-pane to a log file with -o so the pipe is open", () => {
		const args = buildPipePaneArgs("term-x", "/tmp/x.log");
		expect(args[0]).toBe("pipe-pane");
		expect(args).toContain("-t");
		expect(args).toContain("term-x");
		expect(args).toContain("-o");
		// Last arg is the shell command "cat >> /tmp/x.log"
		expect(args[args.length - 1]).toContain("/tmp/x.log");
		expect(args[args.length - 1]).toContain(">>");
	});
});

describe("parseLogTail", () => {
	it("returns all lines + the new byte offset on first read", () => {
		const log = "a\nb\nc\n";
		expect(parseLogTail(log, 0)).toEqual({ lines: ["a", "b", "c"], nextOffset: 6 });
	});

	it("returns only new lines when called with a previous offset", () => {
		const log = "a\nb\nc\n";
		// Caller has already consumed bytes 0..2 ("a\n").  Next call returns b,c.
		expect(parseLogTail(log, 2)).toEqual({ lines: ["b", "c"], nextOffset: 6 });
	});

	it("returns no lines when offset is at end-of-log", () => {
		const log = "a\nb\nc\n";
		expect(parseLogTail(log, 6)).toEqual({ lines: [], nextOffset: 6 });
	});

	it("strips ANSI control sequences while keeping printable chars", () => {
		const log = "hello\nworld\x1b[2m·\x1b[22m\n";
		const out = parseLogTail(log, 0);
		expect(out.lines[0]).toBe("hello");
		expect(out.lines[1]).toContain("world");
		expect(out.lines[1]).toContain("·");
	});

	it("ignores trailing partial line so polling never duplicates it", () => {
		const log = "complete\npartial-no-newline";
		const out = parseLogTail(log, 0);
		expect(out.lines).toEqual(["complete"]);
		expect(out.nextOffset).toBe(9); // length of "complete\n"
	});
});

// -------------------------------------------------------
// Live tests: spawn a real tmux session, drive it, kill it
// -------------------------------------------------------

const liveSessions: string[] = [];
afterAll(() => {
	for (const s of liveSessions) {
		try {
			execFileSync("tmux", ["kill-session", "-t", s], { stdio: "ignore" });
		} catch {
			/* already gone */
		}
	}
});

describe("spawnTmuxSession — live", () => {
	it.if(live)(
		"spawns a real tmux session, captures pipe-pane output, send-keys works, kill-session ends it",
		async () => {
			const handle = await spawnTmuxSession({
				command: "/bin/sh",
				args: ["-i"],
				cwd: process.cwd(),
				cols: 100,
				rows: 30,
			});
			liveSessions.push(handle.sessionId);

			expect(await hasSession(handle.sessionId)).toBe(true);
			expect(handle.pid).toBeGreaterThan(0);
			expect(existsSync(handle.logPath)).toBe(true);

			// Send a marker via send-keys
			await sendKeys(handle.sessionId, "printf MARKER-TMUX-OK");
			// Give tmux a moment to flush pipe-pane to disk
			await new Promise((r) => setTimeout(r, 800));

			const tail = readSessionLog(handle.logPath, 0);
			const concat = tail.lines.join("\n");
			expect(concat).toContain("MARKER-TMUX-OK");

			// Kill it
			await killTmuxSession(handle.sessionId);
			await new Promise((r) => setTimeout(r, 200));
			expect(await hasSession(handle.sessionId)).toBe(false);
		},
		8000,
	);
});
