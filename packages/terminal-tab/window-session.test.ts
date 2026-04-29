/**
 * Tests for window-session — spawn Terminal.app windows for /term --window.
 *
 * Pure helpers (script-builder, sessionId generator, osascript builder)
 * tested directly. The end-to-end osascript spawn is tested when
 * WINDOW_INTEGRATION=1 (gated because it actually opens Terminal.app
 * which is rude to do unprompted in CI).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "./session-store.js";
import {
	buildOsascript,
	buildWrapperScript,
	generateSessionId,
	spawnInWindow,
} from "./window-session.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "window-session-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("generateSessionId", () => {
	it("returns a unique term-prefixed string", () => {
		const a = generateSessionId();
		const b = generateSessionId();
		expect(a).toMatch(/^term-/);
		expect(b).toMatch(/^term-/);
		expect(a).not.toBe(b);
	});
});

describe("buildWrapperScript", () => {
	it("writes the wrapper's pid to the pid-file before exec'ing the command", () => {
		const script = buildWrapperScript({
			pidFile: "/tmp/foo.pid",
			command: "claude",
			args: [],
			cwd: "/Users/me/proj",
		});
		expect(script).toContain("echo $$ >");
		expect(script).toContain("/tmp/foo.pid");
		expect(script).toContain('cd "/Users/me/proj"');
		expect(script).toContain("exec 'claude'");
	});

	it("escapes single quotes inside command args", () => {
		const script = buildWrapperScript({
			pidFile: "/tmp/x.pid",
			command: "/bin/sh",
			args: ["-c", "echo 'hi there'"],
			cwd: "/tmp",
		});
		// We pass each arg quoted; the inner single quote becomes '\''
		expect(script).toContain(`'echo '\\''hi there'\\'''`);
	});

	it("includes a clear banner line so the user sees where they are", () => {
		const script = buildWrapperScript({
			pidFile: "/tmp/x.pid",
			command: "claude",
			args: [],
			cwd: "/tmp",
			label: "Claude Code",
		});
		expect(script).toContain("8gent session");
		expect(script).toContain("Claude Code");
	});
});

describe("buildOsascript", () => {
	it("wraps the wrapper script in an osascript do-script call", () => {
		const osa = buildOsascript("echo hi");
		expect(osa).toContain('tell application "Terminal"');
		expect(osa).toContain("do script");
		expect(osa).toContain("activate");
		expect(osa).toContain("echo hi");
	});

	it("escapes embedded double quotes for AppleScript", () => {
		const osa = buildOsascript('echo "hi"');
		// AppleScript escapes " as \"
		expect(osa).toContain('echo \\"hi\\"');
	});
});

// Live integration — opens a Terminal.app window. Off by default.
describe("spawnInWindow — live", () => {
	const live = process.env.WINDOW_INTEGRATION === "1";
	it.if(live)(
		"spawns a long-running command in a real Terminal.app window and reports its pid",
		async () => {
			const handle = await spawnInWindow({
				command: "/bin/sh",
				args: ["-c", "sleep 30"],
				label: "8gent test",
				cwd: process.cwd(),
				dir,
			});
			expect(handle.sessionId).toMatch(/^term-/);
			expect(handle.pid).toBeGreaterThan(0);
			expect(isPidAlive(handle.pid)).toBe(true);

			// The session JSON should exist
			const sessionFile = join(dir, `${handle.sessionId}.json`);
			expect(existsSync(sessionFile)).toBe(true);
			const session = JSON.parse(readFileSync(sessionFile, "utf-8"));
			expect(session.command).toBe("/bin/sh");

			// Clean up — kill the wrapper process; Terminal.app window can stay
			// open with the dead shell, the test isn't here to babysit windows.
			try {
				process.kill(handle.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		},
		15000,
	);
});
