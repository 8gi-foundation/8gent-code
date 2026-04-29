/**
 * @8gent/terminal-tab — window-session.ts
 *
 * Spawns a real Terminal.app window via osascript for /term --window.
 * Used when the in-tab line-streaming view can't render the target CLI
 * properly (claude's box-drawing UI, openclaw's TUI, anything that
 * positions text via cursor moves).
 *
 * Architecture:
 *   1. We generate a sessionId.
 *   2. We build a small bash wrapper that writes its own PID to a file
 *      then exec's the actual command. This gives us the PID without
 *      needing AppleScript voodoo.
 *   3. osascript opens Terminal.app with the wrapper as the do-script.
 *   4. We poll the PID file until it appears (or timeout) and return
 *      a handle the TUI can use to focus/kill the window.
 *
 * Reconnection: the session is also written to ~/.8gent/sessions/<id>.json
 * via session-store, so 8gent on next launch reads that, prunes dead
 * pids, and restores live ones as window-mode tabs.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_DIR, type WindowSession, saveSession } from "./session-store.js";

const execFileAsync = promisify(execFile);

export interface SpawnInWindowOpts {
	command: string;
	args?: string[];
	cwd?: string;
	label?: string;
	/** Override session-store dir (tests use this). */
	dir?: string;
	/** Override session-id (tests use this). */
	sessionId?: string;
	/** Max ms to wait for the wrapper to write its pid. */
	pidTimeoutMs?: number;
}

export interface WindowSessionHandle {
	sessionId: string;
	pid: number;
	command: string;
	args: string[];
	label: string;
	cwd: string;
	startedAt: string;
}

export function generateSessionId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `term-${ts}-${rand}`;
}

export interface BuildWrapperArgs {
	pidFile: string;
	command: string;
	args?: string[];
	cwd: string;
	label?: string;
}

/** Single-quote a string for safe shell embedding: foo'bar → 'foo'\''bar' */
function shellSingleQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the bash one-liner that the Terminal.app window will run.
 * It writes its PID, prints a banner, cd's to the working dir, then
 * exec's the command so the wrapper *becomes* the command (PID stable).
 */
export function buildWrapperScript(args: BuildWrapperArgs): string {
	const { pidFile, command, cwd, label } = args;
	const cmdArgs = args.args ?? [];

	const banner = `printf '\\033[2m── 8gent session ── %s ──\\033[0m\\n' ${shellSingleQuote(label ?? command)}`;

	const quotedCommand = shellSingleQuote(command);
	const quotedArgs = cmdArgs.map(shellSingleQuote).join(" ");

	const lines = [
		`echo $$ > ${shellSingleQuote(pidFile)}`,
		banner,
		`cd "${cwd.replace(/"/g, '\\"')}"`,
		`exec ${quotedCommand}${quotedArgs ? ` ${quotedArgs}` : ""}`,
	];
	return lines.join("; ");
}

/**
 * Wrap a bash command in an AppleScript that opens a new Terminal.app
 * window and runs it. Embedded double quotes are escaped.
 */
export function buildOsascript(bashCommand: string): string {
	const escaped = bashCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return ['tell application "Terminal"', `  do script "${escaped}"`, "  activate", "end tell"].join(
		"\n",
	);
}

/** Poll for a file every 50ms up to timeoutMs. Returns null on timeout. */
async function waitForFile(path: string, timeoutMs: number): Promise<string | null> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(path)) {
			try {
				const contents = readFileSync(path, "utf-8").trim();
				if (contents) return contents;
			} catch {
				/* race: keep polling */
			}
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return null;
}

/**
 * Open a new Terminal.app window running the given command, persist the
 * session metadata, and return a handle with the wrapper's PID.
 */
export async function spawnInWindow(opts: SpawnInWindowOpts): Promise<WindowSessionHandle> {
	const sessionId = opts.sessionId ?? generateSessionId();
	const cwd = opts.cwd ?? process.cwd();
	const label = opts.label ?? opts.command;
	const dir = opts.dir ?? DEFAULT_DIR;
	const pidFile = join(tmpdir(), `${sessionId}.pid`);

	const wrapper = buildWrapperScript({
		pidFile,
		command: opts.command,
		args: opts.args,
		cwd,
		label,
	});
	const osa = buildOsascript(wrapper);

	await execFileAsync("osascript", ["-e", osa]);

	const pidText = await waitForFile(pidFile, opts.pidTimeoutMs ?? 5000);
	const pid = pidText ? Number.parseInt(pidText, 10) : 0;

	// Best-effort cleanup of the pid file — we have the value now.
	try {
		unlinkSync(pidFile);
	} catch {
		/* ignore */
	}

	const startedAt = new Date().toISOString();
	const session: WindowSession = {
		sessionId,
		command: opts.command,
		args: opts.args ?? [],
		label,
		pid,
		cwd,
		startedAt,
		source: "preset",
	};
	saveSession(session, dir);

	return { sessionId, pid, command: opts.command, args: opts.args ?? [], label, cwd, startedAt };
}

/**
 * Bring the Terminal.app application to the foreground. We don't track
 * individual window IDs in this MVP — `activate` brings Terminal forward
 * with the most recently used window, which matches user intent ~99% of
 * the time. Per-window activation is a follow-up.
 */
export async function focusWindow(_sessionId: string): Promise<void> {
	const osa = `tell application "Terminal" to activate`;
	try {
		await execFileAsync("osascript", ["-e", osa]);
	} catch {
		/* activation is best-effort */
	}
}

/** Send SIGTERM to the wrapper process. */
export function killSession(pid: number): boolean {
	if (!pid || pid < 1) return false;
	try {
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}
