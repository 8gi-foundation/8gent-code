/**
 * Tests for @8gent/terminal-tab — pty-session.
 *
 * These tests run end-to-end: bun:test (under Bun) spawns the
 * `pty-bridge.cjs` subprocess (under Node), and we verify that
 * onData / write / kill / onExit all flow through the JSON protocol.
 *
 * If the test runner has no Node binary available the tests skip
 * with a clear message rather than hanging.
 *
 * #3458: off CI, they also skip with the reason printed when the host refuses
 * to open a pty (a sandbox), because the bridge would exit 65 and every case
 * would fail on the host, not the code. The check uses python3's os.openpty,
 * independent of node-pty. If python3 is missing or fails for any other
 * reason the check is inconclusive and the cases run.
 *
 * Two things never skip:
 *   - CI. With CI or GITHUB_ACTIONS set, a refused pty only prints a warning
 *     and the cases run and fail as before. A skipped case on a gate is
 *     coverage nobody sees.
 *   - node-pty missing (bridge exit 66). The beforeAll below fails the file
 *     with the bridge's own message (#4143), on CI and off it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findNodeBinary } from "./find-node.js";
import { PtySession } from "./pty-session.js";

const nodeBin = findNodeBinary();
const nodeAvailable = Boolean(nodeBin);

// POSIX-only: these cases run /bin/sh (or $SHELL) inside the pty, which a Windows host does not have.
const posixShell = process.platform !== "win32";

// #4143: when node-pty did not build, the bridge exits 66 and every case below
// failed as "Expected: 0, Received: 66". Run the bridge once first and fail
// with its own message instead. bun then reports one "(fail) (unnamed)" and
// the cases do not run: still red, never a skip. CI's "Preflight native deps"
// step explains it before the suite starts.
beforeAll(() => {
	if (!nodeAvailable || !posixShell) return;
	const r = spawnSync(
		nodeBin as string,
		[join(import.meta.dir, "pty-bridge.cjs"), "/bin/sh", "-c", "true"],
		{
			cwd: import.meta.dir,
			encoding: "utf-8",
			timeout: 15_000,
		},
	);
	if (r.status !== 66) return;
	const exit = r.stdout
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l) as { type: string; error?: string })
		.find((m) => m.type === "exit");
	throw new Error(
		`pty-bridge exited 66: node-pty is not installed or did not build (${exit?.error ?? "no reason given"}). Fix: sudo apt install python3 make g++, then rm -rf node_modules/node-pty && bun install. On CI, check "node-gyp --version" is on PATH before bun install.`,
	);
});

function errorLine(s: string | undefined): string {
	const lines = (s ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return lines.find((l) => /Error/.test(l)) ?? lines[0] ?? "";
}

const onCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

// Returns why this host cannot give the bridge a pty, or null when it can or
// the answer is unknown. Never consulted for node-pty: that is exit 66, which
// the beforeAll turns into a loud failure.
function ptyRefusedReason(): string | null {
	if (!nodeAvailable || !posixShell) return null;
	// Same require the bridge makes, from the bridge's folder. If node-pty does
	// not load, do not skip: let the beforeAll fail with the exit-66 message.
	const load = spawnSync(nodeBin as string, ["-e", "require('node-pty')"], {
		cwd: import.meta.dir,
		encoding: "utf-8",
		timeout: 15_000,
	});
	if (load.status !== 0) return null;
	const open = spawnSync("python3", ["-c", "import os; os.openpty()"], {
		encoding: "utf-8",
		timeout: 15_000,
	});
	if (open.error) return null; // python3 unavailable: inconclusive, run the cases
	// Only a refused openpty counts. Any other failure (a broken python3 shim,
	// say) is inconclusive, and the cases run.
	if (open.status !== 0 && /openpty|OSError|PermissionError/.test(open.stderr ?? "")) {
		return `this host refuses to open a pty, so the bridge would exit 65: ${errorLine(open.stderr)}`;
	}
	return null;
}

const ptyRefused = ptyRefusedReason();
const skipReason = ptyRefused && !onCI ? ptyRefused : null;
if (ptyRefused && onCI) {
	const msg = `${ptyRefused.replace(/\r?\n/g, " ")}. Running the cases anyway: CI never skips them.`;
	console.warn(`[pty-session.test] ${msg}`);
	if (process.env.GITHUB_ACTIONS)
		console.log(`::warning title=pty-session: no pty on this runner::${msg}`);
} else if (skipReason) {
	console.warn(`[pty-session.test] SKIPPED: ${skipReason}`);
}
const runCases = nodeAvailable && posixShell && skipReason === null;

const SHELL = process.env.SHELL || "/bin/bash";

describe("PtySession — bridge spawn + capture output", () => {
	it.if(runCases)(
		"spawns a one-shot command and emits its stdout via onData",
		async () => {
			const session = new PtySession({
				command: "/bin/sh",
				args: ["-c", "printf pong; sleep 0.05"],
				cwd: process.cwd(),
				cols: 80,
				rows: 24,
			});

			let captured = "";
			session.onData((chunk) => {
				captured += chunk;
			});

			const exitCode = await session.exited;

			expect(exitCode).toBe(0);
			expect(captured).toContain("pong");
		},
		8000,
	);

	it.if(runCases)(
		"forwards stdin writes back through onData (echo loop)",
		async () => {
			const session = new PtySession({
				command: SHELL,
				args: ["-i"],
				cwd: process.cwd(),
				cols: 80,
				rows: 24,
			});

			let captured = "";
			session.onData((chunk) => {
				captured += chunk;
			});

			await session.ready;
			await new Promise((r) => setTimeout(r, 250));

			session.write("printf MARKER-OK\n");
			await new Promise((r) => setTimeout(r, 600));

			session.kill();
			await session.exited;

			expect(captured).toContain("MARKER-OK");
		},
		8000,
	);
});

describe("PtySession — lifecycle", () => {
	it.if(runCases)(
		"reports pid after ready and null after exit",
		async () => {
			const session = new PtySession({
				command: "/bin/sh",
				args: ["-c", "sleep 1"],
				cwd: process.cwd(),
			});

			await session.ready;
			expect(typeof session.pid).toBe("number");
			expect(session.pid).toBeGreaterThan(0);

			session.kill();
			await session.exited;

			expect(session.pid).toBeNull();
			expect(session.isAlive).toBe(false);
		},
		5000,
	);

	it.if(runCases)(
		"invokes onExit callback with exit code",
		async () => {
			const session = new PtySession({
				command: "/bin/sh",
				args: ["-c", "exit 7"],
				cwd: process.cwd(),
			});

			let exitCode: number | null = null;
			session.onExit((code) => {
				exitCode = code;
			});

			await session.exited;
			// Bridge dispatches `exit` over JSON before its own subprocess
			// closes; give the listener microtask one tick to run.
			await new Promise((r) => setTimeout(r, 50));
			expect(exitCode as unknown as number).toBe(7);
		},
		5000,
	);
});

describe("PtySession — resize", () => {
	it.if(runCases)(
		"resize() does not throw on a live session",
		async () => {
			const session = new PtySession({
				command: "/bin/sh",
				args: ["-c", "sleep 0.5"],
				cwd: process.cwd(),
			});
			await session.ready;
			expect(() => session.resize(120, 40)).not.toThrow();
			session.kill();
			await session.exited;
		},
		5000,
	);

	it.if(runCases)(
		"resize() is a no-op on a dead session (does not throw)",
		async () => {
			const session = new PtySession({
				command: "/bin/sh",
				args: ["-c", "exit 0"],
				cwd: process.cwd(),
			});
			await session.exited;
			expect(() => session.resize(80, 24)).not.toThrow();
		},
		5000,
	);
});
