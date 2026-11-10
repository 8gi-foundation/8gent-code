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
 *   4. `tmux send-keys -t <id> -l -- "TEXT"` then `send-keys Enter` injects prompts on
 *      demand. No Accessibility permission, no AppleScript voodoo.
 *
 * Pure command-builders are exported so the unit tests don't need
 * tmux installed; the live spawn path is gated behind a runtime
 * `tmux -V` probe.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { stripControl } from "./ansi-strip.js";
import { isPidAlive } from "./session-store.js";

const execFileAsync = promisify(execFile);

const STATE_ROOT = join(homedir(), ".8gent");

/** Session logs. Mode 0700; each log 0600, deleted when its session is removed. */
export const SESSIONS_LOG_DIR = join(STATE_ROOT, "sessions");

/** Where each run keeps its tmux socket and owner record. Mode 0700. */
export const TMUX_SOCKET_DIR = join(STATE_ROOT, "term");

/** Logs left by a crash are deleted at startup once older than this. */
export const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One app run's own tmux server (#146). The socket path carries a per-run id
 * (process id plus a random suffix), so two copies of the app never share a
 * server: one run's cleanup can never end another run's sessions, and the
 * person's default tmux server is never addressed. Beside the socket sits an
 * owner record holding the run's process id, so a startup sweep can tell a
 * dead run's socket from a live one.
 */
export interface TmuxRun {
	id: string;
	pid: number;
	dir: string;
	socketPath: string;
	ownerPath: string;
}

const RUN_ID = /^(\d+)-[0-9a-f]{8}$/;

/** A fresh run identity. Pure: nothing is written until claimRun. */
export function newTmuxRun(dir: string = TMUX_SOCKET_DIR, pid: number = process.pid): TmuxRun {
	const id = `${pid}-${randomBytes(4).toString("hex")}`;
	return {
		id,
		pid,
		dir,
		socketPath: join(dir, `${id}.sock`),
		ownerPath: join(dir, `${id}.pid`),
	};
}

const currentRun = newTmuxRun();

/** This process's run. */
export function thisTmuxRun(): TmuxRun {
	return currentRun;
}

/** Prefix a tmux argv with a run's private socket (this run's by default). */
export function tmuxArgv(args: string[], run: TmuxRun = currentRun): string[] {
	return ["-S", run.socketPath, ...args];
}

/** Run tmux on this run's private server, argv only, never a shell string. */
function tmux(args: string[]) {
	return execFileAsync("tmux", tmuxArgv(args));
}

/** Create `dir` if needed and set it to 0700 (an older version may have left it looser). */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

/** Write the run's owner record (0600) in its 0700 directory. Safe to repeat. */
export function claimRun(run: TmuxRun = currentRun): void {
	ensurePrivateDir(run.dir);
	const fd = openSync(run.ownerPath, "w", 0o600);
	try {
		writeSync(fd, `${run.pid}\n`);
	} finally {
		closeSync(fd);
	}
	chmodSync(run.ownerPath, 0o600);
}

/** Remove a run's socket file and owner record. */
export function releaseRun(run: TmuxRun = currentRun): void {
	rmSync(run.socketPath, { force: true });
	rmSync(run.ownerPath, { force: true });
}

/** Runs tmux synchronously with an argv (never a shell string); throws on failure. */
export type TmuxSyncRunner = (argv: string[]) => string;

export const realTmuxSync: TmuxSyncRunner = (argv) =>
	execFileSync("tmux", argv, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 3000,
	});

/**
 * The process id a run's owner record names, or null when that cannot be
 * read for sure: missing, unreadable, not a plain positive integer, or not
 * the process id the run id was made from.
 */
function recordedOwner(dir: string, id: string): number | null {
	const m = RUN_ID.exec(id);
	if (!m) return null;
	let text: string;
	try {
		text = readFileSync(join(dir, `${id}.pid`), "utf-8");
	} catch {
		return null;
	}
	if (!/^\d+\n?$/.test(text)) return null;
	const pid = Number.parseInt(text, 10);
	if (!(pid > 0) || String(pid) !== m[1]) return null;
	return pid;
}

/**
 * Startup sweep of other runs' sockets. A socket is removed (its server
 * stopped, then the socket and owner record deleted) only when its owner
 * record names a process that no longer exists. A missing or unreadable
 * record, a live process, or this run's own id: left alone. Returns the ids
 * swept.
 */
export function sweepDeadRuns(
	dir: string = TMUX_SOCKET_DIR,
	run: TmuxSyncRunner = realTmuxSync,
	alive: (pid: number) => boolean = isPidAlive,
	self: TmuxRun = currentRun,
): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const ids = new Set<string>();
	for (const n of names) {
		const m = /^(.+)\.(sock|pid)$/.exec(n);
		if (m && RUN_ID.test(m[1])) ids.add(m[1]);
	}
	const swept: string[] = [];
	for (const id of ids) {
		if (id === self.id) continue;
		const pid = recordedOwner(dir, id);
		if (pid === null || alive(pid)) continue;
		const socketPath = join(dir, `${id}.sock`);
		if (existsSync(socketPath)) {
			try {
				run(["-S", socketPath, "kill-server"]);
			} catch {
				/* no server left on it */
			}
		}
		rmSync(socketPath, { force: true });
		rmSync(join(dir, `${id}.pid`), { force: true });
		swept.push(id);
	}
	return swept;
}

/** Create a session log as an empty 0600 file (tmux appends to it, keeping the mode). */
export function createSessionLog(logPath: string): void {
	const fd = openSync(logPath, "a", 0o600);
	closeSync(fd);
	chmodSync(logPath, 0o600);
}

/** Delete a session log. Only a regular file is ever removed. */
export function removeSessionLog(logPath: string): void {
	try {
		if (lstatSync(logPath).isFile()) rmSync(logPath, { force: true });
	} catch {
		/* already gone */
	}
}

/**
 * Startup backstop for logs a crash left behind: in `dir`, a `.log` older
 * than LOG_MAX_AGE_MS is deleted; a younger one that an older version left
 * readable by others is tightened to 0600. Returns what it did.
 */
export function sweepSessionLogs(
	dir: string = SESSIONS_LOG_DIR,
	now: number = Date.now(),
): { deleted: string[]; tightened: string[] } {
	const out = { deleted: [] as string[], tightened: [] as string[] };
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const n of names) {
		if (!n.endsWith(".log")) continue;
		const p = join(dir, n);
		try {
			const st = lstatSync(p);
			if (!st.isFile()) continue;
			if (now - st.mtimeMs > LOG_MAX_AGE_MS) {
				rmSync(p, { force: true });
				out.deleted.push(n);
			} else if ((st.mode & 0o077) !== 0) {
				chmodSync(p, 0o600);
				out.tightened.push(n);
			}
		} catch {
			/* gone or unreadable: skip */
		}
	}
	return out;
}

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

/**
 * The exact string tmux hands to sh for a spawn. With no args the command is
 * passed through as written (so a caller may give a full command line); with
 * args every token is single-quoted. Anything that gates a spawn must judge
 * this string, never a re-quoted copy of its inputs.
 */
export function composeShellCommand(command: string, cmdArgs: string[] = []): string {
	return cmdArgs.length === 0
		? command
		: `${shellSingleQuote(command)} ${cmdArgs.map(shellSingleQuote).join(" ")}`;
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
	// tmux's last positional is "shell-command": a single string it runs through sh.
	const composed = composeShellCommand(args.command, cmdArgs);
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

/**
 * Argv for typing `text` into a pane. `-l` sends it literally, so text that
 * happens to spell a tmux key name (BSpace, C-u, Up, Enter...) is typed as
 * characters and never acts as a key. `--` stops a leading dash being read
 * as a flag. Enter is a separate call (buildEnterKeyArgs): after `-l` every
 * argument is literal, and a trailing `;` in text must never be read by tmux
 * as a command separator, so the two are never chained into one argv.
 */
export function buildSendKeysArgs(sessionId: string, text: string): string[] {
	return ["send-keys", "-t", sessionId, "-l", "--", text];
}

/** Argv for pressing the Enter key (a key name, so no `-l`). */
export function buildEnterKeyArgs(sessionId: string): string[] {
	return ["send-keys", "-t", sessionId, "Enter"];
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
	if (opts.logPath === undefined) ensurePrivateDir(SESSIONS_LOG_DIR);
	else ensureDir(dirname(logPath));
	// The log holds whatever the terminal echoes, secrets included: owner only.
	createSessionLog(logPath);
	claimRun();

	try {
		return await startSession(sessionId, cwd, logPath, opts);
	} catch (err) {
		removeSessionLog(logPath);
		throw err;
	}
}

async function startSession(
	sessionId: string,
	cwd: string,
	logPath: string,
	opts: TmuxSpawnOpts,
): Promise<TmuxSessionHandle> {
	// 1. Start the detached session
	const newArgs = buildTmuxNewSessionArgs({
		sessionId,
		command: opts.command,
		cmdArgs: opts.args,
		cwd,
		cols: opts.cols,
		rows: opts.rows,
	});
	await tmux(newArgs);

	// 2. Wire the pipe-pane logger
	const pipeArgs = buildPipePaneArgs(sessionId, logPath);
	await tmux(pipeArgs);

	// 3. Probe pid of the running command (the pane's foreground pid)
	let pid = 0;
	try {
		const { stdout } = await tmux(["list-panes", "-t", sessionId, "-F", "#{pane_pid}"]);
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
	// Terminal.app runs this line in its own shell, so it is the one string form.
	// Every part is app made: this run's socket path and a generated session id.
	const cmd = `tmux -S ${shellSingleQuote(currentRun.socketPath)} attach -t ${shellSingleQuote(sessionId)}`;
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
	if (text.length > 0) await tmux(buildSendKeysArgs(sessionId, text));
	if (opts.appendEnter !== false) await tmux(buildEnterKeyArgs(sessionId));
}

export async function hasSession(sessionId: string): Promise<boolean> {
	try {
		await tmux(["has-session", "-t", sessionId]);
		return true;
	} catch {
		return false;
	}
}

export async function killTmuxSession(sessionId: string): Promise<void> {
	try {
		await tmux(["kill-session", "-t", sessionId]);
	} catch {
		/* already gone */
	}
}

export async function listTmuxSessions(): Promise<string[]> {
	try {
		const { stdout } = await tmux(["list-sessions", "-F", "#{session_name}"]);
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
