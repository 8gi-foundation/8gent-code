/**
 * 8gent Code - Terminal Hook
 *
 * Manages PTY-backed terminal tabs. Each tab gets its own session, which lives
 * until the tab is closed (not until the view unmounts).
 * The TUI runs under Bun, where node-pty cannot deliver onData
 * events directly, so the actual PTY work is delegated to a Node
 * subprocess (`pty-bridge.cjs`) wrapped by @8gent/terminal-tab's
 * PtySession. Output is parsed line-by-line via the package's
 * stripControl + RingBuffer helpers.
 *
 * Agents call writeToTerminal() (registry-based) to inject input
 * into a tab's PTY.
 */

import { useCallback, useEffect, useState } from "react";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { PtySession, RingBuffer, stripControl } from "../../../../packages/terminal-tab/index.js";
import { presetEnv } from "../lib/external-agent-runner.js";

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
// Per-tab state, owned by this module and not by the view
// -------------------------------------------------------
//
// A terminal tab outlives its view: the view unmounts whenever the person
// switches to another tab, and the program in the tab (a shell, claude, pi)
// must keep running, keep its output, and stay reachable by write_terminal and
// read_terminal from chat tab 1. Only closing the tab, or the program exiting,
// ends a session.

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

interface TabState {
	opts: TerminalSpawnOpts;
	session: PtySession | null;
	buffer: RingBuffer;
	pending: string;
	running: boolean;
	pid: number | null;
	subs: Set<() => void>;
}

const _tabs = new Map<string, TabState>();

/** How long a tab may show nothing before it says it is still waiting. */
const STILL_STARTING_MS = 2000;

function snapshot(tab: TabState | undefined): TerminalState {
	if (!tab) return { lines: [], isRunning: false, pid: null };
	return { lines: tab.buffer.toArray(), isRunning: tab.running, pid: tab.pid };
}

function notify(tab: TabState): void {
	for (const fn of tab.subs) fn();
}

/** A plain line in the tab itself, so a failure is seen where the person is looking. */
function tabNotice(tab: TabState, text: string): void {
	tab.buffer.pushMany([text]);
	notify(tab);
}

function startTab(tabId: string, tab: TabState): void {
	const workDir = tab.opts.cwd || process.cwd();
	const command = tab.opts.command ?? SHELL;
	const args = tab.opts.args ?? (tab.opts.command ? [] : ["-i"]);
	tab.buffer = new RingBuffer(MAX_LINES);
	tab.pending = "";
	tab.running = false;
	tab.pid = null;

	let session: PtySession;
	try {
		// A program tab (/term pi) gets a PATH without "." or in-project entries,
		// so what it runs cannot find a binary the folder planted (#4769).
		session = new PtySession({
			command,
			args,
			cwd: workDir,
			...(tab.opts.command ? { env: presetEnv(workDir) } : {}),
			cols: 120,
			rows: 30,
		});
	} catch (err) {
		tab.session = null;
		tabNotice(
			tab,
			`could not start a terminal: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	tab.session = session;
	let ready = false;

	session.onData((data) => {
		const r = splitOutput(tab.pending, data);
		tab.pending = r.pending;
		if (r.lines.length === 0) return;
		tab.buffer.pushMany(r.lines);
		notify(tab);
	});
	session.onExit((code) => {
		if (tab.session !== session) return; // replaced by a restart
		_registry.delete(tabId);
		tab.running = false;
		tab.pid = null;
		// Ended before it ever started: a silent "stopped" would read as a stall.
		if (!ready && code !== 66) {
			const why = session.lastError ?? `exit code ${code ?? "unknown"}`;
			tab.buffer.pushMany([`could not start a terminal: ${why}`]);
		}
		notify(tab);
	});
	_registry.set(tabId, {
		session,
		label: (tab.opts.command ?? SHELL).split("/").pop() || "shell",
		readApproved: false,
		writeApproved: false,
		buffer: tab.buffer,
	});

	session.ready.then(() => {
		if (tab.session !== session) return;
		ready = true;
		tab.running = true;
		tab.pid = session.pid;
		notify(tab);
	});
	setTimeout(() => {
		if (tab.session === session && !ready && session.isAlive) {
			tabNotice(tab, "still starting a terminal: no answer from the helper after 2 seconds");
		}
	}, STILL_STARTING_MS).unref?.();
}

/** Open the tab's session, or return the one already running for it. */
export function openTerminal(tabId: string, opts: TerminalSpawnOpts = {}): void {
	if (_tabs.has(tabId)) return;
	const tab: TabState = {
		opts,
		session: null,
		buffer: new RingBuffer(MAX_LINES),
		pending: "",
		running: false,
		pid: null,
		subs: new Set(),
	};
	_tabs.set(tabId, tab);
	startTab(tabId, tab);
}

/** End a tab's session and forget it. Called when the tab is closed. */
export function closeTerminal(tabId: string): void {
	const tab = _tabs.get(tabId);
	_registry.delete(tabId);
	_tabs.delete(tabId);
	const session = tab?.session;
	if (!tab || !session) return;
	tab.session = null;
	try {
		session.kill();
	} catch {
		/* already dead */
	}
}

/** Close every session whose tab is no longer open. */
export function pruneTerminals(openTabIds: ReadonlySet<string>): void {
	for (const id of [..._tabs.keys()]) if (!openTabIds.has(id)) closeTerminal(id);
}

/** Subscribe to a tab's changes; returns the unsubscribe. The session is not touched. */
export function subscribeTerminal(tabId: string, fn: () => void): () => void {
	const tab = _tabs.get(tabId);
	if (!tab) return () => {};
	tab.subs.add(fn);
	return () => tab.subs.delete(fn);
}

/** What the tab shows now. */
export function terminalState(tabId: string): TerminalState {
	return snapshot(_tabs.get(tabId));
}

export function useTerminal(tabId: string, cwdOrOpts?: string | TerminalSpawnOpts) {
	const opts: TerminalSpawnOpts =
		typeof cwdOrOpts === "string" ? { cwd: cwdOrOpts } : (cwdOrOpts ?? {});
	const [state, setState] = useState<TerminalState>(() => terminalState(tabId));

	// Attach on mount, detach on unmount. Detaching never kills the session.
	// biome-ignore lint/correctness/useExhaustiveDependencies: opts only matter when the session is first created
	useEffect(() => {
		openTerminal(tabId, opts);
		setState(terminalState(tabId));
		return subscribeTerminal(tabId, () => setState(terminalState(tabId)));
	}, [tabId]);

	/** Forward raw bytes to the PTY (user keystrokes - no newline injection). */
	const writeRaw = useCallback(
		(bytes: string) => {
			_tabs.get(tabId)?.session?.write(bytes);
		},
		[tabId],
	);

	/** Write a command line to the terminal (appends \n if missing). */
	const write = useCallback(
		(input: string) => writeRaw(input.endsWith("\n") ? input : `${input}\n`),
		[writeRaw],
	);

	/** Resize the PTY when terminal dimensions change */
	const resize = useCallback(
		(cols: number, rows: number) => {
			_tabs.get(tabId)?.session?.resize(cols, rows);
		},
		[tabId],
	);

	/** Kill and restart the shell */
	const restart = useCallback(() => {
		const tab = _tabs.get(tabId);
		if (!tab) return;
		const old = tab.session;
		tab.session = null;
		_registry.delete(tabId);
		try {
			old?.kill();
		} catch {
			/* ignore */
		}
		notify(tab);
		setTimeout(() => startTab(tabId, tab), 50);
	}, [tabId]);

	return { ...state, write, writeRaw, resize, restart };
}
