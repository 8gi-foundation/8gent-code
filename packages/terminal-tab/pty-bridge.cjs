#!/usr/bin/env node
/**
 * @8gent/terminal-tab — pty-bridge.cjs
 *
 * Subprocess that runs under Node and hosts a single node-pty child.
 * The 8gent TUI runs under Bun, where node-pty's onData never fires
 * (libuv FD-watching gap in Bun's N-API). The bridge owns the real
 * PTY and proxies it to the parent via newline-delimited JSON over
 * stdin/stdout.
 *
 * Protocol:
 *   parent → bridge (stdin):
 *     {"type":"write","data":"..."}
 *     {"type":"resize","cols":N,"rows":M}
 *     {"type":"kill","signal":"SIGTERM"}
 *   bridge → parent (stdout):
 *     {"type":"ready","pid":N}
 *     {"type":"data","data":"..."}
 *     {"type":"exit","code":N,"signal":N|null}
 *
 * stderr is reserved for bridge-internal diagnostics.
 *
 * Spawn args: [command, ...args]
 * Env:
 *   PTY_CWD   - working directory (defaults to process.cwd())
 *   PTY_COLS  - initial columns (defaults to 120)
 *   PTY_ROWS  - initial rows (defaults to 30)
 */

"use strict";

// node-pty is an optionalDependency (#3256): it compiles from source on Linux,
// and a machine without Python and a C++ toolchain skips it rather than
// failing `npm install -g`. Without it, terminal tabs cannot open a shell.
// Say so inside the tab, then exit with a code of its own (66), instead of
// dying on a stack trace the TUI never shows.
const NO_PTY_EXIT = 66;
const NO_PTY_MESSAGE =
	"Terminal tabs are unavailable: the node-pty module is not installed.\r\n" +
	"It needs build tools on this machine. On Debian or Ubuntu:\r\n" +
	"  sudo apt install python3 make g++\r\n" +
	"  npm install -g @8gi-foundation/8gent-code\r\n" +
	"Everything else in 8gent works without it.\r\n";

let pty;
try {
	pty = require("node-pty");
} catch (err) {
	const lines = [
		{ type: "data", data: NO_PTY_MESSAGE },
		{
			type: "exit",
			code: NO_PTY_EXIT,
			signal: null,
			error: String(err?.message ?? err).split("\n")[0],
		},
	];
	// Synchronous write: process.exit must not drop the message.
	require("node:fs").writeSync(1, lines.map((m) => `${JSON.stringify(m)}\n`).join(""));
	process.exit(NO_PTY_EXIT);
}

// bun install skips node-pty's lifecycle scripts and writes the prebuilt
// `spawn-helper` binary without its execute bit, which makes every
// pty.spawn on macOS fail with "posix_spawnp failed." (surfaced here as
// exit 65). Self-heal: restore the bit before the first spawn. No-op when
// the module was built from source (no prebuilds) or the bit is already set.
(function ensureSpawnHelperExecutable() {
	try {
		const fs = require("node:fs");
		const path = require("node:path");
		const prebuilds = path.join(
			path.dirname(require.resolve("node-pty/package.json")),
			"prebuilds",
		);
		for (const dir of fs.readdirSync(prebuilds)) {
			const helper = path.join(prebuilds, dir, "spawn-helper");
			if (!fs.existsSync(helper)) continue;
			const mode = fs.statSync(helper).mode;
			if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o755);
		}
	} catch {
		// prebuilds absent or unreadable - nothing to heal
	}
})();

function send(msg) {
	try {
		process.stdout.write(`${JSON.stringify(msg)}\n`);
	} catch {
		// parent closed; we'll exit on the next event loop tick
	}
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
	send({ type: "exit", code: 64, signal: null });
	process.exit(64);
}

const command = argv[0];
const args = argv.slice(1);
const cwd = process.env.PTY_CWD || process.cwd();
const cols = Math.max(1, Number.parseInt(process.env.PTY_COLS || "120", 10));
const rows = Math.max(1, Number.parseInt(process.env.PTY_ROWS || "30", 10));

let child;
try {
	child = pty.spawn(command, args, {
		name: "xterm-256color",
		cols,
		rows,
		cwd,
		env: process.env,
	});
} catch (err) {
	send({
		type: "exit",
		code: 65,
		signal: null,
		error: String(err?.message ?? err),
	});
	process.exit(65);
}

send({ type: "ready", pid: child.pid });

child.onData((chunk) => {
	send({ type: "data", data: chunk });
});

child.onExit(({ exitCode, signal }) => {
	send({ type: "exit", code: exitCode, signal: signal ?? null });
	// Give stdout a tick to flush before terminating.
	setTimeout(() => process.exit(0), 10);
});

// node-pty throws ENXIO on master fd close while a read is pending — expected
process.on("uncaughtException", (err) => {
	if (err?.code === "ENXIO") return;
	process.stderr.write(`[pty-bridge] uncaught: ${err?.stack ?? err}\n`);
});

// ---------------- stdin loop: parse line-delimited JSON commands ----------------

let buffer = "";

process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let idx;
	while ((idx = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		handle(msg);
	}
});

process.stdin.on("end", () => {
	// Parent closed our stdin — kill the child and exit.
	try {
		child.kill();
	} catch {
		/* already dead */
	}
});

function handle(msg) {
	if (!msg || typeof msg !== "object") return;
	switch (msg.type) {
		case "write":
			if (typeof msg.data === "string") {
				try {
					child.write(msg.data);
				} catch {
					/* PTY closed — exit handler will fire */
				}
			}
			break;
		case "resize":
			if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
				try {
					child.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
				} catch {
					/* PTY closed */
				}
			}
			break;
		case "kill":
			try {
				child.kill(typeof msg.signal === "string" ? msg.signal : undefined);
			} catch {
				/* already dead */
			}
			break;
	}
}
