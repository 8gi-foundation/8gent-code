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
import { PtySession, RingBuffer, stripControl } from "../../../../packages/terminal-tab/index.js";

const SHELL = process.env.SHELL || "/bin/zsh";
const MAX_LINES = 1000;

// -------------------------------------------------------
// Global registry: tabId → PtySession
// Used by write_terminal tool (outside React lifecycle)
// -------------------------------------------------------

interface PTYEntry {
	session: PtySession;
}

const _registry = new Map<string, PTYEntry>();

/** Called by write_terminal tool to send input to a tab's PTY */
export function writeToTerminal(tabId: string, input: string): string {
	const entry = _registry.get(tabId);
	if (!entry) return `No terminal open for tab ${tabId}`;
	entry.session.write(input.endsWith("\n") ? input : `${input}\n`);
	return `Sent to terminal tab ${tabId}`;
}

/** List open terminal tabs */
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

export function useTerminal(tabId: string, cwd?: string) {
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
			// Strip control sequences (keeping SGR), then split on newlines.
			const cleaned = stripControl(pendingRef.current + data);
			const parts = cleaned.split("\n");
			pendingRef.current = parts.pop() ?? "";

			const newLines = parts.filter((l) => l.length > 0);
			if (newLines.length === 0) return;

			bufferRef.current.pushMany(newLines);
			flushLines();
		},
		[flushLines],
	);

	// Spawn PTY when tab is first shown
	const spawn = useCallback(() => {
		if (sessionRef.current) return; // already running

		const workDir = cwd || process.cwd();
		const session = new PtySession({
			command: SHELL,
			args: ["-i"],
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

		_registry.set(tabId, { session });

		session.ready.then(() => {
			setState({ lines: [], isRunning: true, pid: session.pid });
		});
	}, [tabId, cwd, appendOutput]);

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

	/** Write a command to the terminal (user-typed or agent-sent) */
	const write = useCallback((input: string) => {
		const session = sessionRef.current;
		if (!session) return;
		session.write(input.endsWith("\n") ? input : `${input}\n`);
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

	return { ...state, write, resize, restart };
}
