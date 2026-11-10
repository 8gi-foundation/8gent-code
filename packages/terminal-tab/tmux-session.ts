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
import { dirname, join, resolve } from "node:path";
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

let currentRun = newTmuxRun();

/** This process's run. */
export function thisTmuxRun(): TmuxRun {
	return currentRun;
}

/** Tests only: point this process at a run under a scratch directory, never the real home. */
export function setTmuxRunForTest(run: TmuxRun): void {
	currentRun = run;
}

/**
 * Exact-match targets (#146 review). A bare name lets tmux fall back to a
 * prefix or pattern match, so an id whose session has died could reach a
 * look-alike that a nested program made. `=id` matches the session name
 * exactly; pane commands need the `=id:` form.
 */
export function exactSession(id: string): string {
	return `=${id}`;
}
export function exactPane(id: string): string {
	return `=${id}:`;
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
 * True when tmux ran to the end and said no (an exit status, no signal), as
 * opposed to a timeout, a kill or tmux not starting at all, which prove nothing.
 */
function tmuxSaidNo(err: unknown): boolean {
	const e = err as { status?: unknown; signal?: unknown } | null;
	return typeof e?.status === "number" && e.status !== 0 && !e.signal;
}

/**
 * Stop the tmux server on `socketPath` and report whether it is gone (#146
 * review, item 4). Gone means that after kill-server, tmux itself answers
 * that no server is running there (a socket file outlives its server). A
 * timeout, a server still answering, or any other failure is not proof, so
 * the caller keeps the socket and owner record for the next start's sweep.
 */
export function stopServer(socketPath: string, run: TmuxSyncRunner = realTmuxSync): boolean {
	try {
		run(["-S", socketPath, "kill-server"]);
	} catch (err) {
		if (!tmuxSaidNo(err)) return false;
	}
	try {
		run(["-S", socketPath, "list-sessions"]);
		return false; // still answering
	} catch (err) {
		return tmuxSaidNo(err);
	}
}

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
		// A server whose stop did not take keeps its socket: removed, it could never be found again.
		if (existsSync(socketPath) && !stopServer(socketPath, run)) continue;
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

/**
 * `dir` is a real directory (never a symbolic link) owned by this user, so
 * deleting inside it cannot reach anywhere else.
 */
function isOwnLogDir(dir: string): boolean {
	try {
		const st = lstatSync(dir);
		if (!st.isDirectory()) return false;
		const uid = process.getuid?.();
		return uid === undefined || st.uid === uid;
	} catch {
		return false;
	}
}

/**
 * Delete a session log. Only a regular file (never a symbolic link) directly
 * inside `dir`, which must itself be a real directory and not a link, is ever
 * removed; anything else is left alone.
 */
export function removeSessionLog(logPath: string, dir: string = SESSIONS_LOG_DIR): void {
	if (resolve(dirname(logPath)) !== resolve(dir) || !isOwnLogDir(dir)) return;
	try {
		if (lstatSync(logPath).isFile()) rmSync(logPath, { force: true });
	} catch {
		/* already gone */
	}
}

/** The only log name term_spawn makes: the app prefix plus 12 hex digits. */
const APP_LOG_NAME = /^8gent-term-[0-9a-f]{12}\.log$/;

/**
 * Startup sweep of session logs in `dir`, regular files only. A `.log` that
 * is not one the app now makes (the pre-#146 `term-<ts>-<rand>.log` files,
 * which hold echoed bytes) is deleted whatever its age and never read. An
 * app log that a crash left behind is deleted once older than
 * LOG_MAX_AGE_MS, and tightened to 0600 if it is readable by others.
 * Returns what it did.
 */
export function sweepSessionLogs(
	dir: string = SESSIONS_LOG_DIR,
	now: number = Date.now(),
): { deleted: string[]; tightened: string[] } {
	const out = { deleted: [] as string[], tightened: [] as string[] };
	// A linked or foreign directory is never swept: nothing outside the app's own is deleted.
	if (!isOwnLogDir(dir)) return out;
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
			if (!APP_LOG_NAME.test(n) || now - st.mtimeMs > LOG_MAX_AGE_MS) {
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

/**
 * The only variables a session's program gets (#146 item 4), the same list
 * packages/eight/local-runtime.ts gives a started server. tmux puts TMUX and
 * TMUX_PANE (this run's socket path and the pane) into every pane, after any
 * -e flag, and the server passes on the whole environment it started with.
 * So the program runs under `env -i` with only these, plus the pane's TERM.
 */
export const SESSION_ENV_ALLOW = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TZ",
] as const;

/** The allowlisted variables from `env`, minus any value that names the socket directory. */
export function sessionEnv(
	env: NodeJS.ProcessEnv = process.env,
	run: TmuxRun = currentRun,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of SESSION_ENV_ALLOW) {
		const v = env[k];
		if (v !== undefined && !v.includes(run.dir)) out[k] = v;
	}
	return out;
}

/**
 * The string tmux runs for a session: `composed` (the string the gate judged)
 * under `/usr/bin/env -i` with only `env` and the pane's TERM, through /bin/sh.
 * Neither TMUX, TMUX_PANE nor the socket path reaches the program.
 *
 * What remains (said plainly): this binds what the program is handed, not
 * what it can find. A program running as the same user can still locate the
 * socket, for example by listing ~/.8gent/term or reading the tmux server's
 * command line (`ps`), and then drive every session on it. The 0700 directory
 * stops other users only. Making the socket unusable to a same-user process
 * is not possible without also locking out this app, which is the same user.
 */
export function sessionShellCommand(
	composed: string,
	env: Record<string, string> = sessionEnv(),
): string {
	const vars = Object.entries(env)
		.map(([k, v]) => `${k}=${shellSingleQuote(v)}`)
		.join(" ");
	return `exec /usr/bin/env -i TERM="$TERM" ${vars ? `${vars} ` : ""}/bin/sh -c ${shellSingleQuote(composed)}`;
}

/** Build the argv for `tmux new-session -d -s <id> -x C -y R -c CWD CMD...`. */
export function buildTmuxNewSessionArgs(
	args: BuildNewSessionArgs,
	env: Record<string, string> = sessionEnv(),
): string[] {
	const cmdArgs = args.cmdArgs ?? [];
	const cols = args.cols ?? 200;
	const rows = args.rows ?? 50;
	// tmux's last positional is "shell-command": a single string it runs through
	// its default shell. The gate judges composeShellCommand(...); the wrapper
	// around it is app made and only sets the environment (#146 item 4).
	const shellCommand = sessionShellCommand(composeShellCommand(args.command, cmdArgs), env);
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
		shellCommand,
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
	return ["send-keys", "-t", exactPane(sessionId), "-l", "--", text];
}

/** Argv for pressing the Enter key (a key name, so no `-l`). */
export function buildEnterKeyArgs(sessionId: string): string[] {
	return ["send-keys", "-t", exactPane(sessionId), "Enter"];
}

export function buildPipePaneArgs(sessionId: string, logPath: string): string[] {
	// `-o` keeps the pipe enabled across new commands inside the pane.
	// We use `>>` so reattach/resume doesn't truncate the existing log.
	const shell = `cat >> ${shellSingleQuote(logPath)}`;
	return ["pipe-pane", "-t", exactPane(sessionId), "-o", shell];
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
		// The file made a moment ago at the path this spawn was given.
		removeSessionLog(logPath, dirname(logPath));
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
		const { stdout } = await tmux(["list-panes", "-t", exactPane(sessionId), "-F", "#{pane_pid}"]);
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
	const cmd = `tmux -S ${shellSingleQuote(currentRun.socketPath)} attach -t ${shellSingleQuote(exactSession(sessionId))}`;
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
		await tmux(["has-session", "-t", exactSession(sessionId)]);
		return true;
	} catch {
		return false;
	}
}

export async function killTmuxSession(sessionId: string): Promise<void> {
	try {
		await tmux(["kill-session", "-t", exactSession(sessionId)]);
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
