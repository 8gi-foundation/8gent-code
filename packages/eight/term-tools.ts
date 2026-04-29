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

import {
	type WindowSession,
	attachInTerminal,
	deleteSession,
	getSession,
	hasTmuxSession,
	isTmuxAvailable,
	killTmuxSession,
	listTmuxSessions,
	loadSessions,
	readSessionLog,
	saveSession,
	sendTmuxKeys,
	spawnTmuxSession,
} from "../terminal-tab/index.js";

// ---------------- Per-session read offsets ----------------
//
// Each session log grows over time.  We track per-session "last byte we
// already returned to the agent" so successive `term_read` calls only
// surface new output.  Lives in this module because the agent is
// stateless across tool calls but the cursor needs to persist.
//
const readOffsets = new Map<string, number>();

// ---------------- Tool definitions ----------------

export function getTermToolDefs(): object[] {
	return [
		{
			type: "function",
			function: {
				name: "term_spawn",
				description:
					"[ORCHESTRATION] Spawn an external CLI in a real Terminal.app window via tmux. Returns a sessionId you can use with term_send / term_read. Examples of valid commands: 'claude', 'openclaw', 'pi', '/bin/sh'. Use this when delegating a task to a different agent CLI is cheaper than answering yourself, or when you want to parallelise work across multiple sub-agents.",
				parameters: {
					type: "object",
					properties: {
						command: {
							type: "string",
							description: "Binary on $PATH — e.g. 'claude', 'openclaw', 'pi'.",
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
					"[ORCHESTRATION] Send a prompt to a running session's stdin via tmux send-keys. Pair with term_read after a short delay to see the response. By default Enter is appended so the prompt is submitted.",
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
					"[ORCHESTRATION] Read new output from a session's tmux pipe-pane log since the last term_read call. Returns lines with ANSI control sequences stripped. Call repeatedly to poll for the response.",
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
					"[ORCHESTRATION] List all active windowed sessions 8gent is currently orchestrating, with their command, label, and uptime.",
				parameters: { type: "object", properties: {}, required: [] },
			},
		},
		{
			type: "function",
			function: {
				name: "term_kill",
				description:
					"[ORCHESTRATION] Kill a running session and close its tmux + Terminal.app window state.",
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
	if (!isTmuxAvailable()) {
		return "ERR: tmux is not installed. Run `brew install tmux` (macOS) or `apt install tmux` (Linux) so 8gent can orchestrate windowed sessions.";
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
	const cmdArgs = Array.isArray(args.args) ? (args.args as string[]).map(String) : [];
	const label = (args.label as string | undefined) ?? command;

	const handle = await spawnTmuxSession({
		command,
		args: cmdArgs,
		cwd: process.cwd(),
		cols: 200,
		rows: 50,
	});

	// Open a Terminal.app window so the human can watch / take over.
	try {
		await attachInTerminal(handle.sessionId);
	} catch {
		/* attaching is best-effort; tmux session is still running detached */
	}

	// Persist for cross-restart reconnection.
	const session: WindowSession = {
		sessionId: handle.sessionId,
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
		sessionId: handle.sessionId,
		pid: handle.pid,
		logPath: handle.logPath,
		label,
		command: handle.command,
	});
}

async function termSend(args: Record<string, unknown>): Promise<string> {
	const sessionId = String(args.sessionId ?? "").trim();
	const text = String(args.text ?? "");
	if (!sessionId) return "ERR: term_send needs sessionId.";
	if (!(await hasTmuxSession(sessionId))) {
		return `ERR: session "${sessionId}" is not running.`;
	}
	const appendEnter = args.appendEnter !== false;
	await sendTmuxKeys(sessionId, text, { appendEnter });
	return JSON.stringify({ ok: true, sessionId, sent: text, enter: appendEnter });
}

async function termRead(args: Record<string, unknown>): Promise<string> {
	const sessionId = String(args.sessionId ?? "").trim();
	if (!sessionId) return "ERR: term_read needs sessionId.";

	const session = getSession(sessionId);
	if (!session) return `ERR: no persisted session for "${sessionId}".`;

	// Resolve log path from the tmux session's expected location.
	const logPath = `${process.env.HOME}/.8gent/sessions/${sessionId}.log`;

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
	const tmuxNames = await listTmuxSessions();
	const persisted = loadSessions();
	const live = persisted.filter((s) => tmuxNames.includes(s.sessionId));

	const rows = live.map((s) => {
		const elapsedMs = Date.now() - new Date(s.startedAt).getTime();
		return {
			sessionId: s.sessionId,
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
	const sessionId = String(args.sessionId ?? "").trim();
	if (!sessionId) return "ERR: term_kill needs sessionId.";
	await killTmuxSession(sessionId);
	deleteSession(sessionId);
	readOffsets.delete(sessionId);
	return JSON.stringify({ ok: true, sessionId, killed: true });
}
