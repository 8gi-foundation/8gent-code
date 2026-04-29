/**
 * Tests for @8gent/terminal-tab — pty-session.
 *
 * These tests run end-to-end: bun:test (under Bun) spawns the
 * `pty-bridge.cjs` subprocess (under Node), and we verify that
 * onData / write / kill / onExit all flow through the JSON protocol.
 *
 * If the test runner has no Node binary available the tests skip
 * with a clear message rather than hanging.
 */

import { describe, expect, it } from "bun:test";
import { findNodeBinary } from "./find-node.js";
import { PtySession } from "./pty-session.js";

const nodeAvailable = (() => {
	const bin = findNodeBinary();
	return Boolean(bin);
})();

const SHELL = process.env.SHELL || "/bin/bash";

describe("PtySession — bridge spawn + capture output", () => {
	it.if(nodeAvailable)(
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

	it.if(nodeAvailable)(
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
	it.if(nodeAvailable)(
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

	it.if(nodeAvailable)(
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
			expect(exitCode).toBe(7);
		},
		5000,
	);
});

describe("PtySession — resize", () => {
	it.if(nodeAvailable)(
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

	it.if(nodeAvailable)(
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
