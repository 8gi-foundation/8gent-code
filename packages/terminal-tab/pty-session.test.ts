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
 * #3458: they also skip, with the reason printed, when the host cannot give
 * the bridge a pty at all. Two such conditions, both outside this package:
 *   - node-pty cannot be loaded. It is an optionalDependency with no Linux
 *     prebuild, so on ubuntu CI it exists only if `node-gyp rebuild` succeeded
 *     during `bun install`, and bun does not report when that build fails.
 *     The bridge then exits 66 and every test here failed. The 66 path itself
 *     is covered by pty-bridge-no-pty.test.ts.
 *   - the host refuses openpty (a sandbox), so the bridge exits 65.
 * The openpty check uses python3, independent of node-pty; if python3 is
 * missing the check is inconclusive and the tests run.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { findNodeBinary } from "./find-node.js";
import { PtySession } from "./pty-session.js";

function errorLine(s: string | undefined): string {
	const lines = (s ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return lines.find((l) => /Error/.test(l)) ?? lines[0] ?? "";
}

function ptySkipReason(): string | null {
	const bin = findNodeBinary();
	if (!bin) return "no Node binary found";
	// Same require the bridge makes, resolved from the bridge's own folder.
	const load = spawnSync(bin, ["-e", "require('node-pty')"], {
		cwd: import.meta.dir,
		encoding: "utf-8",
		timeout: 15_000,
	});
	if (load.status !== 0) {
		return `node-pty cannot be loaded by ${bin}, so the bridge would exit 66: ${errorLine(load.stderr) || String(load.error ?? "")}`;
	}
	const open = spawnSync("python3", ["-c", "import os; os.openpty()"], {
		encoding: "utf-8",
		timeout: 15_000,
	});
	if (open.error) return null; // python3 unavailable: inconclusive, run the tests
	// Only a refused openpty counts. Any other failure (a broken python3 shim,
	// say) is inconclusive, and the tests run.
	if (open.status !== 0 && /openpty|OSError|PermissionError/.test(open.stderr ?? "")) {
		return `this host refuses to open a pty, so the bridge would exit 65: ${errorLine(open.stderr)}`;
	}
	return null;
}

const skipReason = ptySkipReason();
if (skipReason) {
	console.warn(`[pty-session.test] SKIPPED: ${skipReason}`);
	// Surface lost coverage on the GitHub Actions run summary.
	if (process.env.GITHUB_ACTIONS) {
		console.log(`::warning title=pty-session tests skipped::${skipReason.replace(/\r?\n/g, " ")}`);
	}
}
const ptyAvailable = skipReason === null;

const SHELL = process.env.SHELL || "/bin/bash";

describe("PtySession — bridge spawn + capture output", () => {
	it.if(ptyAvailable)(
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

	it.if(ptyAvailable)(
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
	it.if(ptyAvailable)(
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

	it.if(ptyAvailable)(
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
	it.if(ptyAvailable)(
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

	it.if(ptyAvailable)(
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
