/**
 * @8gent/eight — term-tools.ts
 *
 * Agent-callable tools for orchestrating external CLI sessions running
 * in real Terminal.app windows via tmux. The boss-tab agent uses these
 * to autonomously dispatch work to claude, openclaw, pi, etc., read
 * their output back, and decide what to do next.
 *
 * Architecture: see packages/terminal-tab/tmux-session.ts.
 *
 * Two-line wiring in tools.ts:
 *   1. spread `getTermToolDefs()` into `getToolDefinitions()`
 *   2. delegate `term_*` cases in `execute()` to `executeTermTool()`
 *
 * The agent does not need to know about pty-bridges, osascript, or
 * window IDs. It just calls term_spawn / term_send / term_read.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { commandSegments } from "../permissions/command-policy.js";
import { getPermissionManager } from "../permissions/index.js";
import { sanitizeShellCommand } from "../permissions/shell-sanitizer";
import {
	type TmuxRun,
	type TmuxSyncRunner,
	type WindowSession,
	attachInTerminal,
	composeShellCommand,
	deleteSession,
	hasTmuxSession,
	isTmuxAvailable,
	killTmuxSession,
	listTmuxSessions,
	readSessionLog,
	realTmuxSync,
	releaseRun,
	removeSessionLog,
	saveSession,
	sendTmuxKeys,
	spawnTmuxSession,
	stopServer,
	sweepDeadRuns,
	sweepSessionLogs,
	thisTmuxRun,
	tmuxArgv,
} from "../terminal-tab/index.js";

// ---------------- Sessions this run started (#146) ----------------
//
// term_send, term_read and term_kill reach only a session that term_spawn
// started in this app run, matched exactly on the tmux target it created.
// The target is app made (fixed prefix plus a random id); a model-supplied
// label never becomes one. Everything here ends when the app quits.

export interface OwnedSession {
	/** The exact tmux session name term_spawn created; also the sessionId the model uses. */
	target: string;
	label: string;
	command: string;
	args: string[];
	pid: number;
	logPath: string;
	createdAt: string;
}

const owned = new Map<string, OwnedSession>();

/** Fixed prefix of every session name term_spawn makes. */
export const OWNED_PREFIX = "8gent-term-";

/** A fresh, app-made tmux session name: the prefix plus 12 random hex digits. */
export function newOwnedTarget(): string {
	return `${OWNED_PREFIX}${randomBytes(6).toString("hex")}`;
}

/** Sessions this run started, oldest first. */
export function ownedSessions(): OwnedSession[] {
	return [...owned.values()];
}

/**
 * The session for `raw`, or the refusal to hand back. A name tmux would read
 * as target syntax (`:` `.` `=` `*`, whitespace, anything outside letters,
 * digits, `-` and `_`) is refused before any tmux call; anything else must be
 * exactly a registered target. No prefix match, no pattern.
 */
function resolveOwned(
	tool: string,
	raw: unknown,
	nothing: string,
): { session: OwnedSession } | { refusal: string } {
	const id = typeof raw === "string" ? raw : "";
	if (!id) return { refusal: `ERR: ${tool} needs sessionId.` };
	const shown = JSON.stringify(id.slice(0, 80));
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		return {
			refusal: `[BLOCKED] ${tool}: ${shown} is not a valid session id. ${nothing}`,
		};
	}
	const session = owned.get(id);
	if (!session) {
		return {
			refusal: `[BLOCKED] ${tool}: ${shown} is not a session started by term_spawn in this run. ${nothing}`,
		};
	}
	return { session };
}

export type { TmuxSyncRunner };

/**
 * Remove one session from this run: its log is deleted (it holds whatever the
 * terminal echoed, secrets included), with its saved record and cursors. Used
 * by term_kill and by exit cleanup. term_spawn sessions have no app tab:
 * closing their Terminal.app window only detaches the viewer, so the session
 * and its log stay until term_kill or the app quits. A program that exits on
 * its own also leaves the log in place until then.
 */
function forgetSession(s: OwnedSession): void {
	removeSessionLog(s.logPath);
	try {
		deleteSession(s.target);
	} catch {
		/* best effort */
	}
	readOffsets.delete(s.target);
	pendingInput.delete(s.target);
	owned.delete(s.target);
}

/**
 * End every session this run started, then stop this run's own tmux server
 * and remove its socket and owner record (N1). Only `termRun`'s socket is
 * ever addressed, so another copy of the app keeps its sessions.
 * Synchronous so it can run from an exit handler. Safe to call more than once.
 */
export function endOwnedSessions(
	run: TmuxSyncRunner = realTmuxSync,
	termRun: TmuxRun = thisTmuxRun(),
): void {
	const hadSessions = owned.size > 0;
	for (const s of [...owned.values()]) {
		try {
			// `=` makes the target an exact name, never a prefix or pattern.
			run(tmuxArgv(["kill-session", "-t", `=${s.target}`], termRun));
		} catch {
			/* already gone */
		}
		forgetSession(s);
	}
	// Release the socket and owner record only once the server is confirmed
	// gone. A server that outlived its socket file could never be found again;
	// kept, the next start's sweep stops it once this process is dead.
	if ((hadSessions || existsSync(termRun.socketPath)) && !stopServer(termRun.socketPath, run)) {
		return;
	}
	try {
		releaseRun(termRun);
	} catch {
		/* best effort */
	}
}

let swept = false;
/**
 * Once per run, at startup: stop and remove sockets whose owning run is
 * provably dead, and apply the 30 day backstop to session logs a crash left.
 */
export function sweepTermStateOnce(): void {
	if (swept) return;
	swept = true;
	try {
		sweepDeadRuns();
	} catch {
		/* best effort */
	}
	try {
		sweepSessionLogs();
	} catch {
		/* best effort */
	}
}

export interface ExitHost {
	on(event: string, fn: () => void): unknown;
	removeListener(event: string, fn: () => void): unknown;
	listenerCount(event: string): number;
	kill(pid: number, signal: string): unknown;
	pid: number;
}

/**
 * Run `cleanup` on exit and on SIGINT, SIGTERM and SIGHUP. On a signal the
 * handler steps aside and, if nobody else listens, raises it again so the
 * process still ends (the pattern apps/tui/src/lib/bang-command.ts and
 * lib/mouse-input.ts use). Returns the uninstaller.
 */
export function endSessionsOnExit(
	cleanup: () => void = () => endOwnedSessions(),
	host: ExitHost = process as unknown as ExitHost,
): () => void {
	const onExit = () => cleanup();
	const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => {
		const fn = (): void => {
			cleanup();
			host.removeListener(sig, fn);
			if (host.listenerCount(sig) === 0) host.kill(host.pid, sig);
		};
		host.on(sig, fn);
		return [sig, fn] as const;
	});
	host.on("exit", onExit);
	return () => {
		host.removeListener("exit", onExit);
		for (const [sig, fn] of handlers) host.removeListener(sig, fn);
	};
}

let exitHooked = false;
function hookExitOnce(): void {
	if (exitHooked) return;
	exitHooked = true;
	endSessionsOnExit();
}

// ---------------- Per-session read offsets ----------------
//
// Each session log grows over time.  We track per-session "last byte we
// already returned to the agent" so successive `term_read` calls only
// surface new output.  Lives in this module because the agent is
// stateless across tool calls but the cursor needs to persist.
//
const readOffsets = new Map<string, number>();

// ---------------- Command policy (#3767) ----------------
//
// term_spawn starts a program and term_send types into a live session, so
// both reach a shell the same way run_command does. Every command line they
// carry goes through the same command policy: the always-blocked list is
// refused, the ask-every-time list asks a person (refused with no terminal),
// in every mode including Infinite. Text that cannot be read with confidence
// as a command is treated as needing a person.

/** Typed but not yet submitted, per session, so a later Enter is judged with it. */
const pendingInput = new Map<string, string>();

/** Most unsubmitted text held per session; past it term_send is refused and the hold is kept. */
export const MAX_PENDING_INPUT = 64 * 1024;

// Tab (0x09) counts: in a shell it triggers completion and can rewrite the line.
const CONTROL_CHARS = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/;

/** True when the line has quotes or shell constructs we cannot read for sure. */
function unreadable(text: string): boolean {
	if (CONTROL_CHARS.test(text)) return true;
	// Known imprecision: $$' is read here as an ANSI-C quote, but bash sees $$ (the pid) then a
	// plain quote. It only errs toward asking, and the quote tracker asks on every piece.
	// $'...' (ANSI-C quoting) treats a backslash as an escape inside single quotes,
	// which the quote tracking below does not model; a person reads it instead.
	if (/\$\(|`|<<|<\(|>\(|\$'/.test(text)) return true;
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		// A line break inside an open quote, or right after a backslash, joins
		// two lines into one command; judged line by line it would slip through.
		if ((c === "\r" || c === "\n") && quote !== null) return true;
		if (c === "\\" && quote !== "'") {
			i++;
			if (i >= text.length) return true;
			if (text[i] === "\r" || text[i] === "\n") return true;
			continue;
		}
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === "'" || c === '"') {
			quote = c;
		}
	}
	return quote !== null;
}

/**
 * What is still on the shell's line after `line` is typed. A newline submits,
 * except right after a backslash or inside an open quote, where the shell
 * keeps reading the same command: that text stays pending, so a later piece
 * is judged together with it. Enter counts as a final newline.
 */
function unsubmitted(line: string, enter: boolean): string {
	const text = enter ? `${line}\n` : line;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (c === "\n" || c === "\r") {
			if (quote === null) start = i + 1;
		} else if (quote) {
			if (c === (quote === "$'" ? "'" : quote)) quote = null;
		} else if (c === "$" && text[i + 1] === "'") {
			// ANSI-C quote: a backslash escapes inside it, unlike a plain single quote.
			quote = "$'";
			i++;
		} else if (c === "'" || c === '"') {
			quote = c;
		}
	}
	return text.slice(start);
}

/** What a prompt shows of long text: the tail, since the end is what a joined command finishes with. */
const PROMPT_TAIL = 4096;
const tail = (t: string) => (t.length > PROMPT_TAIL ? `...${t.slice(-PROMPT_TAIL)}` : t);

/** Null when the input may go ahead, else the refusal to hand back to the agent. */
export async function gateInput(tool: string, text: string): Promise<string | null> {
	const pm = getPermissionManager();
	const lines = text.split(/[\r\n]+/).filter((l) => l.trim() !== "");
	const refuse = (why: string) => `[PERMISSION DENIED] ${tool}: ${why}. Nothing was sent.`;

	// The whole text as the shell may read it: line breaks as separators, and
	// with a backslash continuation joined. A command split across lines is
	// judged whole as well as piece by piece.
	const wholes = [text.replace(/[\r\n]+/g, ";"), text.replace(/\\[\r\n]+/g, "")];
	for (const whole of wholes) {
		for (const part of [whole, ...commandSegments(whole)]) {
			const blocked = pm.alwaysBlockedReason(part);
			if (blocked) return refuse(`blocked by security policy (${blocked}): ${text}`);
		}
	}

	for (const line of lines) {
		for (const part of [line, ...commandSegments(line)]) {
			const blocked = pm.alwaysBlockedReason(part);
			if (blocked) return refuse(`blocked by security policy (${blocked}): ${line}`);
		}
		if (pm.checkPermission(line) === "denied") {
			return refuse(`blocked by security policy: ${line}`);
		}
	}

	if (unreadable(text)) {
		const ok = await pm.askPerson(
			"Type Into Terminal Session",
			"8gent wants to type text that cannot be read as a plain command.",
			tail(text),
		);
		return ok
			? null
			: refuse(`a person declined input that could not be read as a command: ${text}`);
	}

	for (const line of lines) {
		if (pm.checkPermission(line) === "ask") {
			const ok = await pm.requestPermission(
				"Execute Shell Command",
				"8gent wants to run a command in a terminal session.",
				tail(line),
			);
			if (!ok) return refuse(`user declined to run: ${line}`);
		}
	}
	return null;
}

/**
 * The gate for write_terminal. The text goes through the same command policy as
 * term_send, then the first send to each tab asks a person, in every mode
 * including Infinite (a tab can hold another program such as pi or Hermes, so
 * typing into it is a different trust than running a command). The approval
 * lives on the tab's registry entry, so it ends with the session and when the
 * tab closes. Null means go ahead.
 */
export async function gateTabInput(tabId: string, text: string): Promise<string | null> {
	const tabs = await import("../../apps/tui/src/hooks/useTerminal.js");
	const label = tabs.describeTerminal(tabId);
	if (label === null) return `No terminal open for tab ${tabId}. Nothing was sent.`;
	const denied = await gateInput("write_terminal", text);
	if (denied) return denied;
	if (tabs.isTerminalWriteApproved(tabId)) return null;
	const ok = await getPermissionManager().askPerson(
		"Type Into Terminal Tab",
		`The assistant wants to type into terminal tab ${tabId} (running ${label}), which also lets it read that tab. Approving covers this tab until it closes.`,
		tail(text),
	);
	if (!ok) {
		return `[PERMISSION DENIED] write_terminal: a person did not approve typing into tab ${tabId}. Nothing was sent.`;
	}
	tabs.approveTerminalWrite(tabId);
	return null;
}

/**
 * The gate for read_terminal. Output read from a tab goes into the model's
 * context, so a read needs a first-time per-tab approval (Infinite mode
 * included). That approval is read only: it never lets write_terminal type, while
 * a write approval also covers reads. Null means go ahead.
 */
export async function gateTabRead(tabId: string): Promise<string | null> {
	const tabs = await import("../../apps/tui/src/hooks/useTerminal.js");
	const label = tabs.describeTerminal(tabId);
	if (label === null) return `No terminal open for tab ${tabId}.`;
	if (tabs.isTerminalReadApproved(tabId)) return null;
	const ok = await getPermissionManager().askPerson(
		"Read Terminal Tab",
		`The assistant wants to read the output of terminal tab ${tabId} (running ${label}). This is read only: typing into the tab needs its own approval. Approving covers this tab until it closes.`,
	);
	if (!ok) {
		return `[PERMISSION DENIED] read_terminal: a person did not approve reading tab ${tabId}. Nothing was read.`;
	}
	tabs.approveTerminalRead(tabId);
	return null;
}

// ---------------- Tool definitions ----------------

export function getTermToolDefs(): object[] {
	sweepTermStateOnce();
	return [
		{
			type: "function",
			function: {
				name: "term_spawn",
				description:
					"[ORCHESTRATION] Spawns command (a CLI binary on $PATH) in a real Terminal.app window via tmux. Returns a sessionId you can use with term_send / term_read. The sessionId is generated; label is display text only. Sessions end when 8gent closes normally or is stopped by a signal it can catch; after a crash or SIGKILL they keep running until the next start cleans them up. The approval gate covers these tools only, not other programs run by the same user. Examples of valid commands: 'claude', 'openclaw', 'pi', '/bin/sh'. Use this when delegating a task to a different agent CLI is cheaper than answering yourself, or when you want to parallelise work across multiple sub-agents.",
				parameters: {
					type: "object",
					properties: {
						command: {
							type: "string",
							description: "Binary on $PATH, for example 'claude', 'openclaw' or 'pi'.",
						},
						args: {
							type: "array",
							items: { type: "string" },
							description: "Optional argv passed to the command.",
						},
						label: {
							type: "string",
							description: "Human-readable label for the session, shown to the user.",
						},
					},
					required: ["command"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "term_send",
				description:
					"[ORCHESTRATION] Sends text as keystrokes to the running session sessionId (from term_spawn) via tmux send-keys. Pair with term_read after a short delay to see the response. By default Enter is appended so the prompt is submitted.",
				parameters: {
					type: "object",
					properties: {
						sessionId: { type: "string", description: "Session id from term_spawn." },
						text: { type: "string", description: "Text to inject as keystrokes." },
						appendEnter: {
							type: "boolean",
							description: "Whether to press Enter after the text. Default true.",
						},
					},
					required: ["sessionId", "text"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "term_read",
				description:
					"[ORCHESTRATION] Reads new output from session sessionId (from term_spawn) since the last term_read call. Returns lines with ANSI control sequences stripped. Call repeatedly to poll for the response.",
				parameters: {
					type: "object",
					properties: {
						sessionId: { type: "string", description: "Session id from term_spawn." },
						resetCursor: {
							type: "boolean",
							description: "If true, read from the start of the log instead of last cursor.",
						},
					},
					required: ["sessionId"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "term_list",
				description:
					"[ORCHESTRATION] List the sessions term_spawn started in this run that are still running, with their command, label, and uptime. Sessions started any other way are never listed.",
				parameters: { type: "object", properties: {}, required: [] },
			},
		},
		{
			type: "function",
			function: {
				name: "term_kill",
				description:
					"[ORCHESTRATION] Kills session sessionId and closes its tmux + Terminal.app window state.",
				parameters: {
					type: "object",
					properties: {
						sessionId: { type: "string", description: "Session id from term_spawn." },
					},
					required: ["sessionId"],
				},
			},
		},
	];
}

// ---------------- Tool execution ----------------

export function isTermTool(name: string): boolean {
	return name.startsWith("term_");
}

export async function executeTermTool(
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	sweepTermStateOnce();
	if (!isTmuxAvailable()) {
		return "ERR: terminal sessions are unavailable on this machine (tmux was not found). Nothing was started.";
	}

	switch (name) {
		case "term_spawn":
			return termSpawn(args);
		case "term_send":
			return termSend(args);
		case "term_read":
			return termRead(args);
		case "term_list":
			return termList();
		case "term_kill":
			return termKill(args);
		default:
			return `ERR: unknown term tool "${name}"`;
	}
}

async function termSpawn(args: Record<string, unknown>): Promise<string> {
	const command = String(args.command ?? "").trim();
	if (!command) return "ERR: term_spawn needs a command.";
	// The command is run by a shell inside the session: same guard as run_command (#3763).
	const validation = sanitizeShellCommand(command);
	if (!validation.safe) return `[BLOCKED] ${validation.reason}. Command: ${command}`;
	const cmdArgs = Array.isArray(args.args) ? (args.args as string[]).map(String) : [];
	const label = (args.label as string | undefined) ?? command;

	const denied = await gateInput("term_spawn", composeShellCommand(command, cmdArgs));
	if (denied) return denied;

	// The tmux target is app made; the label is shown, never used as a target.
	const target = newOwnedTarget();
	hookExitOnce();
	let handle: Awaited<ReturnType<typeof spawnTmuxSession>>;
	try {
		handle = await spawnTmuxSession({
			command,
			args: cmdArgs,
			cwd: process.cwd(),
			cols: 200,
			rows: 50,
			sessionId: target,
		});
	} catch (err) {
		// new-session may have run before a later step failed: end it.
		await killTmuxSession(target);
		return `ERR: term_spawn could not start the session: ${err instanceof Error ? err.message : String(err)}`;
	}
	owned.set(target, {
		target,
		label,
		command: handle.command,
		args: handle.args,
		pid: handle.pid,
		logPath: handle.logPath,
		createdAt: handle.startedAt,
	});

	// Open a Terminal.app window so the human can watch / take over.
	try {
		await attachInTerminal(target);
	} catch {
		/* attaching is best-effort; tmux session is still running detached */
	}

	// Persist for cross-restart reconnection.
	const session: WindowSession = {
		sessionId: target,
		command: handle.command,
		args: handle.args,
		label,
		pid: handle.pid,
		cwd: handle.cwd,
		startedAt: handle.startedAt,
		source: "preset",
	};
	saveSession(session);

	return JSON.stringify({
		ok: true,
		sessionId: target,
		pid: handle.pid,
		logPath: handle.logPath,
		label,
		command: handle.command,
	});
}

async function termSend(args: Record<string, unknown>): Promise<string> {
	const found = resolveOwned("term_send", args.sessionId, "Nothing was sent.");
	if ("refusal" in found) return found.refusal;
	const sessionId = found.session.target;
	const text = String(args.text ?? "");
	if (!(await hasTmuxSession(sessionId))) {
		return `ERR: session "${sessionId}" is not running.`;
	}
	const appendEnter = args.appendEnter !== false;
	// Judge what is on the line, including text typed earlier and not yet submitted.
	const line = (pendingInput.get(sessionId) ?? "") + text;
	if (line.length > MAX_PENDING_INPUT) {
		// Refuse and leave the hold exactly as it is. Clearing it would not clear the
		// shell's line: the bytes already typed stay there, and padding past the cap
		// would let the next piece be judged alone. Only term_kill clears the hold.
		return `[PERMISSION DENIED] term_send: the pending unsubmitted text is over the ${MAX_PENDING_INPUT} byte cap, so it cannot be checked as one command line. Nothing was sent and the pending text is kept. Use term_kill to end this session and start clean.`;
	}
	const denied = await gateInput("term_send", line);
	if (denied) return denied;
	const rest = unsubmitted(line, appendEnter);
	if (rest === "") pendingInput.delete(sessionId);
	else pendingInput.set(sessionId, rest);
	await sendTmuxKeys(sessionId, text, { appendEnter });
	return JSON.stringify({ ok: true, sessionId, sent: text, enter: appendEnter });
}

async function termRead(args: Record<string, unknown>): Promise<string> {
	const found = resolveOwned("term_read", args.sessionId, "Nothing was read.");
	if ("refusal" in found) return found.refusal;
	const sessionId = found.session.target;
	const logPath = found.session.logPath;

	const cursor = args.resetCursor === true ? 0 : (readOffsets.get(sessionId) ?? 0);
	const tail = readSessionLog(logPath, cursor);
	readOffsets.set(sessionId, tail.nextOffset);

	return JSON.stringify({
		ok: true,
		sessionId,
		newLines: tail.lines,
		nextOffset: tail.nextOffset,
		stillRunning: await hasTmuxSession(sessionId),
	});
}

async function termList(): Promise<string> {
	// Only sessions this run started, and only while tmux still has them.
	const tmuxNames = await listTmuxSessions();
	const live = ownedSessions().filter((s) => tmuxNames.includes(s.target));

	const rows = live.map((s) => {
		const elapsedMs = Date.now() - new Date(s.createdAt).getTime();
		return {
			sessionId: s.target,
			label: s.label,
			command: s.command,
			args: s.args,
			pid: s.pid,
			elapsedSeconds: Math.round(elapsedMs / 1000),
		};
	});

	return JSON.stringify({ ok: true, count: rows.length, sessions: rows });
}

async function termKill(args: Record<string, unknown>): Promise<string> {
	const found = resolveOwned("term_kill", args.sessionId, "Nothing was killed.");
	if ("refusal" in found) return found.refusal;
	const sessionId = found.session.target;
	await killTmuxSession(sessionId);
	forgetSession(found.session);
	return JSON.stringify({ ok: true, sessionId, killed: true });
}
