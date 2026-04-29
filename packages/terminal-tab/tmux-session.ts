/**
 * @8gent/terminal-tab — tmux-session.ts
 *
 * Bidirectional orchestration backend. The boss-tab agent uses this to
 * autonomously spawn external CLIs (claude, openclaw, pi…), send them
 * prompts, read their replies, and decide what to do next.
 *
 * How it stitches together:
 *   1. `tmux new-session -d -s <id>` creates a detached pane running
 *      the command. Real PTY, real isatty, no fakery.
 *   2. `tmux pipe-pane -o "cat >> <log>"` mirrors every byte to a log
 *      file. The agent reads from this file (with stripped ANSI) to
 *      learn what the CLI said.
 *   3. osascript opens a Terminal.app window running `tmux attach -t
 *      <id>` so the human can also see / interact.
 *   4. `tmux send-keys -t <id> "TEXT" Enter` injects prompts on
 *      demand. No Accessibility permission, no AppleScript voodoo.
 *
 * Pure command-builders are exported so the unit tests don't need
 * tmux installed; the live spawn path is gated behind a runtime
 * `tmux -V` probe.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { stripControl } from "./ansi-strip.js";

const execFileAsync = promisify(execFile);

export const SESSIONS_LOG_DIR = join(homedir(), ".8gent", "sessions");

// ---------------- Types ----------------

export interface TmuxSpawnOpts {
	command: string;
	args?: string[];
	cwd?: string;
	cols?: number;
	rows?: number;
	sessionId?: string;
	logPath?: string;
}

export interface TmuxSessionHandle {
	sessionId: string;
	pid: number;
	command: string;
	args: string[];
	logPath: string;
	startedAt: string;
	cwd: string;
}

// ---------------- Pure builders ----------------

function shellSingleQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface BuildNewSessionArgs {
	sessionId: string;
	command: string;
	cmdArgs?: string[];
	cwd: string;
	cols?: number;
	rows?: number;
}

/** Build the argv for `tmux new-session -d -s <id> -x C -y R -c CWD CMD...`. */
export function buildTmuxNewSessionArgs(args: BuildNewSessionArgs): string[] {
	const cmdArgs = args.cmdArgs ?? [];
	const cols = args.cols ?? 200;
	const rows = args.rows ?? 50;
	// tmux's last positional is "shell-command" — a single string it runs through sh.
	// If we have cmdArgs we must compose them into one string with shell-quoted args
	// so tmux invokes the command with them intact.
	const composed =
		cmdArgs.length === 0
			? args.command
			: `${shellSingleQuote(args.command)} ${cmdArgs.map(shellSingleQuote).join(" ")}`;
	return [
		"new-session",
		"-d",
		"-s",
		args.sessionId,
		"-x",
		String(cols),
		"-y",
		String(rows),
		"-c",
		args.cwd,
		composed,
	];
}

export interface BuildSendKeysOpts {
	appendEnter?: boolean;
}

export function buildSendKeysArgs(
	sessionId: string,
	text: string,
	opts: BuildSendKeysOpts = {},
): string[] {
	const out = ["send-keys", "-t", sessionId, text];
	if (opts.appendEnter !== false) out.push("Enter");
	return out;
}

export function buildPipePaneArgs(sessionId: string, logPath: string): string[] {
	// `-o` keeps the pipe enabled across new commands inside the pane.
	// We use `>>` so reattach/resume doesn't truncate the existing log.
	const shell = `cat >> ${shellSingleQuote(logPath)}`;
	return ["pipe-pane", "-t", sessionId, "-o", shell];
}

/** Tail the log file from `byteOffset`. Returns clean lines + new offset. */
export interface ParsedLogTail {
	lines: string[];
	nextOffset: number;
}

export function parseLogTail(rawLog: string, byteOffset: number): ParsedLogTail {
	const slice = rawLog.slice(byteOffset);
	if (!slice) return { lines: [], nextOffset: byteOffset };
	const lastNewline = slice.lastIndexOf("\n");
	if (lastNewline === -1) {
		// Whole slice is partial; advance offset to the end of the previous full line
		// (i.e. don't advance — keep the partial for the next read).
		return { lines: [], nextOffset: byteOffset };
	}
	const consumed = slice.slice(0, lastNewline + 1);
	const cleaned = stripControl(consumed);
	const lines = cleaned.split("\n");
	// trailing empty from final \n
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { lines, nextOffset: byteOffset + consumed.length };
}

// ---------------- Live ops (spawn / send / read / kill) ----------------

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function generateSessionId(prefix = "term"): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${prefix}-${ts}-${rand}`;
}

export async function spawnTmuxSession(opts: TmuxSpawnOpts): Promise<TmuxSessionHandle> {
	const sessionId = opts.sessionId ?? generateSessionId();
	const cwd = opts.cwd ?? process.cwd();
	const logPath = opts.logPath ?? join(SESSIONS_LOG_DIR, `${sessionId}.log`);
	ensureDir(dirname(logPath));

	// 1. Start the detached session
	const newArgs = buildTmuxNewSessionArgs({
		sessionId,
		command: opts.command,
		cmdArgs: opts.args,
		cwd,
		cols: opts.cols,
		rows: opts.rows,
	});
	await execFileAsync("tmux", newArgs);

	// 2. Wire the pipe-pane logger
	const pipeArgs = buildPipePaneArgs(sessionId, logPath);
	await execFileAsync("tmux", pipeArgs);

	// 3. Probe pid of the running command (the pane's foreground pid)
	let pid = 0;
	try {
		const { stdout } = await execFileAsync("tmux", [
			"list-panes",
			"-t",
			sessionId,
			"-F",
			"#{pane_pid}",
		]);
		pid = Number.parseInt(stdout.trim().split("\n")[0] ?? "0", 10) || 0;
	} catch {
		/* leave pid=0 */
	}

	return {
		sessionId,
		pid,
		command: opts.command,
		args: opts.args ?? [],
		logPath,
		startedAt: new Date().toISOString(),
		cwd,
	};
}

/** Open a Terminal.app window attached to the running tmux session. */
export async function attachInTerminal(sessionId: string): Promise<void> {
	const cmd = `tmux attach -t ${shellSingleQuote(sessionId)}`;
	const escaped = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const osa = [
		'tell application "Terminal"',
		`  do script "${escaped}"`,
		"  activate",
		"end tell",
	].join("\n");
	await execFileAsync("osascript", ["-e", osa]);
}

export async function sendKeys(
	sessionId: string,
	text: string,
	opts: BuildSendKeysOpts = {},
): Promise<void> {
	const args = buildSendKeysArgs(sessionId, text, opts);
	await execFileAsync("tmux", args);
}

export async function hasSession(sessionId: string): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["has-session", "-t", sessionId]);
		return true;
	} catch {
		return false;
	}
}

export async function killTmuxSession(sessionId: string): Promise<void> {
	try {
		await execFileAsync("tmux", ["kill-session", "-t", sessionId]);
	} catch {
		/* already gone */
	}
}

export async function listTmuxSessions(): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
		return stdout
			.trim()
			.split("\n")
			.filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

/** Read tail of the session log starting at byteOffset. Returns clean lines + nextOffset. */
export function readSessionLog(logPath: string, byteOffset = 0): ParsedLogTail {
	if (!existsSync(logPath)) return { lines: [], nextOffset: byteOffset };
	const size = statSync(logPath).size;
	if (size <= byteOffset) return { lines: [], nextOffset: byteOffset };
	const raw = readFileSync(logPath, "utf-8");
	return parseLogTail(raw, byteOffset);
}

/** Synchronous probe — used by the agent runtime to decide if tmux backend is available. */
export function isTmuxAvailable(): boolean {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
