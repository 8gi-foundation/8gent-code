/**
 * 8gent Code - Terminal Hook
 *
 * Manages PTY-backed terminal tabs. Each tab gets its own session.
 * The TUI runs under Bun, where node-pty cannot deliver onData
 * events directly, so the actual PTY work is delegated to a Node
 * subprocess (`pty-bridge.cjs`) wrapped by @8gent/terminal-tab's
 * PtySession. Output is parsed line-by-line via the package's
 * stripControl + RingBuffer helpers.
 *
 * Agents call writeToTerminal() (registry-based) to inject input
 * into a tab's PTY.
 */

import { useCallback, useEffect, useRef, useState } from "react";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { PtySession, RingBuffer, stripControl } from "../../../../packages/terminal-tab/index.js";

const SHELL = process.env.SHELL || "/bin/zsh";
const MAX_LINES = 1000;

// -------------------------------------------------------
// Global registry: tabId → PtySession
// Used by write_terminal tool (outside React lifecycle)
// -------------------------------------------------------

interface PTYEntry {
	session: PtySession;
	/** What runs in the tab (command name), shown when a person is asked to approve typing into it. */
	label: string;
	/** A person approved reading this tab's output. Lives on the entry, so it ends when the tab closes. */
	readApproved: boolean;
	/** A person approved typing into this tab (this also allows reading). Ends when the tab closes. */
	writeApproved: boolean;
	/** Same buffer the tab renders from; read_terminal reads it back. */
	buffer: RingBuffer;
}

/** Strip control sequences (keeping SGR) and split on newlines; the trailing partial line stays pending. */
function splitOutput(pending: string, data: string): { lines: string[]; pending: string } {
	const parts = stripControl(pending + data).split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.filter((l) => l.length > 0), pending: rest };
}

// SGR colour codes survive stripControl for rendering; text handed to a model must not carry them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
// PTY lines end in CR LF, so a trailing CR and any other stray control byte go too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes is the point
const CTRL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const SGR = /\x1b\[[0-9;:]*m/g;
// The one-byte CSI (U+009B) introduces the same sequences as ESC [; remove the whole sequence.
const C1_CSI = /\x9b[0-?]*[ -/]*[@-~]/g;

const _registry = new Map<string, PTYEntry>();

/** Called by write_terminal tool to send input to a tab's PTY */
export function writeToTerminal(tabId: string, input: string): string {
	const entry = _registry.get(tabId);
	if (!entry) return `No terminal open for tab ${tabId}`;
	entry.session.write(input.endsWith("\n") ? input : `${input}\n`);
	return `Sent to terminal tab ${tabId}`;
}

/** The command running in a tab, or null when no terminal is open for it. */
export function describeTerminal(tabId: string): string | null {
	return _registry.get(tabId)?.label ?? null;
}

/** Reading is allowed once a person approved reading or typing; typing approval implies reading. */
export function isTerminalReadApproved(tabId: string): boolean {
	const e = _registry.get(tabId);
	return e?.readApproved === true || e?.writeApproved === true;
}

/** Typing is allowed only after a person approved typing; a read approval never counts. */
export function isTerminalWriteApproved(tabId: string): boolean {
	return _registry.get(tabId)?.writeApproved === true;
}

/** Record a person's read approval for this tab until it closes. No-op for an unknown tab. */
export function approveTerminalRead(tabId: string): void {
	const entry = _registry.get(tabId);
	if (entry) entry.readApproved = true;
}

/** Record a person's approval to read and type for this tab until it closes. */
export function approveTerminalWrite(tabId: string): void {
	const entry = _registry.get(tabId);
	if (entry) entry.writeApproved = true;
}

/**
 * Last `lines` lines of a tab's output with every control sequence removed, or
 * null when no terminal is open for the tab. Output is from another program and
 * is untrusted; the caller labels it.
 */
export function readTerminal(tabId: string, lines: number): string[] | null {
	const entry = _registry.get(tabId);
	if (!entry) return null;
	return entry.buffer
		.takeLast(lines)
		.map((l) => l.replace(SGR, "").replace(C1_CSI, "").replace(CTRL, ""));
}

/** Test seam: register a session as a tab and feed its output into a buffer, as the hook does. */
export function _registerTerminalForTest(tabId: string, session: PtySession): void {
	const buffer = new RingBuffer(MAX_LINES);
	let pending = "";
	session.onData((data) => {
		const r = splitOutput(pending, data);
		pending = r.pending;
		buffer.pushMany(r.lines);
	});
	_registry.set(tabId, {
		session,
		buffer,
		label: "test",
		readApproved: false,
		writeApproved: false,
	});
}

/** Test seam: forget a tab. */
export function _unregisterTerminalForTest(tabId: string): void {
	_registry.delete(tabId);
}

/**
 * List open terminal tabs.
 *
 * @public Used cross-workspace by packages/ai/tools.ts via dynamic import; do
 * not drop the export.
 */
export function listTerminals(): string[] {
	return [..._registry.keys()];
}

// -------------------------------------------------------
// Per-tab hook
// -------------------------------------------------------

export interface TerminalState {
	lines: string[];
	isRunning: boolean;
	pid: number | null;
}

export interface TerminalSpawnOpts {
	cwd?: string;
	command?: string;
	args?: string[];
}

export function useTerminal(tabId: string, cwdOrOpts?: string | TerminalSpawnOpts) {
	const opts: TerminalSpawnOpts =
		typeof cwdOrOpts === "string" ? { cwd: cwdOrOpts } : (cwdOrOpts ?? {});
	const [state, setState] = useState<TerminalState>({
		lines: [],
		isRunning: false,
		pid: null,
	});

	const sessionRef = useRef<PtySession | null>(null);
	const bufferRef = useRef<RingBuffer>(new RingBuffer(MAX_LINES));
	const pendingRef = useRef<string>(""); // partial line buffer

	const flushLines = useCallback(() => {
		setState((prev) => ({ ...prev, lines: bufferRef.current.toArray() }));
	}, []);

	const appendOutput = useCallback(
		(data: string) => {
			const split = splitOutput(pendingRef.current, data);
			pendingRef.current = split.pending;

			const newLines = split.lines;
			if (newLines.length === 0) return;

			bufferRef.current.pushMany(newLines);
			flushLines();
		},
		[flushLines],
	);

	// Spawn PTY when tab is first shown
	const spawn = useCallback(() => {
		if (sessionRef.current) return; // already running

		const workDir = opts.cwd || process.cwd();
		const command = opts.command ?? SHELL;
		const args = opts.args ?? (opts.command ? [] : ["-i"]);
		const session = new PtySession({
			command,
			args,
			cwd: workDir,
			cols: 120,
			rows: 30,
		});

		sessionRef.current = session;
		bufferRef.current = new RingBuffer(MAX_LINES);
		pendingRef.current = "";

		session.onData(appendOutput);
		session.onExit(() => {
			_registry.delete(tabId);
			sessionRef.current = null;
			setState({ lines: bufferRef.current.toArray(), isRunning: false, pid: null });
		});

		_registry.set(tabId, {
			session,
			label: (opts.command ?? SHELL).split("/").pop() || "shell",
			readApproved: false,
			writeApproved: false,
			buffer: bufferRef.current,
		});

		session.ready.then(() => {
			setState({ lines: [], isRunning: true, pid: session.pid });
		});
	}, [tabId, opts.cwd, opts.command, opts.args, appendOutput]);

	// Spawn on mount, kill on unmount
	useEffect(() => {
		spawn();
		return () => {
			const session = sessionRef.current;
			if (session) {
				sessionRef.current = null;
				_registry.delete(tabId);
				try {
					session.kill();
				} catch {
					/* already dead */
				}
			}
		};
	}, [tabId, spawn]);

	/** Write a command line to the terminal (agent-sent — appends \n if missing). */
	const write = useCallback((input: string) => {
		const session = sessionRef.current;
		if (!session) return;
		session.write(input.endsWith("\n") ? input : `${input}\n`);
	}, []);

	/** Forward raw bytes to the PTY (user keystrokes — no newline injection). */
	const writeRaw = useCallback((bytes: string) => {
		const session = sessionRef.current;
		if (!session) return;
		session.write(bytes);
	}, []);

	/** Resize the PTY when terminal dimensions change */
	const resize = useCallback((cols: number, rows: number) => {
		const session = sessionRef.current;
		if (!session) return;
		session.resize(cols, rows);
	}, []);

	/** Kill and restart the shell */
	const restart = useCallback(() => {
		const session = sessionRef.current;
		if (session) {
			_registry.delete(tabId);
			try {
				session.kill();
			} catch {
				/* ignore */
			}
			sessionRef.current = null;
		}
		bufferRef.current.clear();
		pendingRef.current = "";
		setState({ lines: [], isRunning: false, pid: null });
		setTimeout(spawn, 50);
	}, [tabId, spawn]);

	return { ...state, write, writeRaw, resize, restart };
}
