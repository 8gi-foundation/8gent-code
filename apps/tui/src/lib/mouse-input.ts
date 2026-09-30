/**
 * Mouse input for the HUD (#3239): one layer in front of Ink.
 *
 * The terminal reports the mouse as SGR sequences on stdin:
 *   ESC [ < b ; x ; y M   press, drag or move (b carries the button and flags)
 *   ESC [ < b ; x ; y m   release
 * x and y are 1-based cells. Ink must never see them: its input parser would
 * turn the bytes into keys, and they would be typed into the chat.
 *
 * What this module does, matching the TUI James uses (8DO observation of its
 * startup, HUD-SYSTEM.md 7a):
 * - enables press, drag, any-motion and SGR reporting (?1000 ?1002 ?1003
 *   ?1006) once per process, and disables them in reverse order on every exit
 *   path, twice over, so a partial write never leaves the shell capturing;
 * - re-enables after SIGCONT, and disables before a SIGTSTP stop;
 * - strips every mouse sequence before Ink reads, keeping a carry-over for a
 *   sequence split across two reads (the old per-chunk regex leaked the tail
 *   of a split sequence into the input), and flushes a held partial after a
 *   short wait, so a lone Esc still arrives;
 * - hands parsed events to subscribers, and lets a click inject the bytes of
 *   the key it stands for, so a click does exactly what the key does.
 *
 * Opt out with EIGHT_MOUSE=0 or `"mouse": "off"` in ~/.8gent/config.json.
 * Off for non-TTY, TERM=dumb and INK_SCREEN_READER=true. NO_COLOR keeps the
 * mouse on: it is a colour preference, not an input one (James's open call;
 * flip MOUSE_UNDER_NO_COLOR to change it).
 */

import { StringDecoder } from "node:string_decoder";

export type MouseKind = "press" | "release" | "drag" | "move" | "wheel";

export interface MouseEvent {
	kind: MouseKind;
	/** 0 left, 1 middle, 2 right; for wheel, 0 up and 1 down. */
	button: number;
	/** 0-based cell column and row. */
	x: number;
	y: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

/** James's open call (#3239): the mouse stays on under NO_COLOR. */
export const MOUSE_UNDER_NO_COLOR = true;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts every mouse report
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** A tail that could still become a mouse sequence: ESC, ESC [, ESC [ < digits;... */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a held partial starts with ESC
const PARTIAL_TAIL = /\x1b(?:\[(?:<[\d;]*)?)?$/;

/** Decode one SGR report. */
export function parseSgr(code: number, col: number, row: number, final: "M" | "m"): MouseEvent {
	const shift = (code & 4) !== 0;
	const alt = (code & 8) !== 0;
	const ctrl = (code & 16) !== 0;
	const motion = (code & 32) !== 0;
	const wheel = (code & 64) !== 0;
	const button = code & 3;
	const base = { x: col - 1, y: row - 1, shift, alt, ctrl };
	if (wheel) return { kind: "wheel", button, ...base };
	if (final === "m") return { kind: "release", button, ...base };
	if (motion) return { kind: button === 3 ? "move" : "drag", button, ...base };
	return { kind: "press", button, ...base };
}

/**
 * Pure filter: feed it what stdin delivered, get back what Ink may see and
 * the mouse events it held. A partial sequence at the end is kept and
 * prefixed to the next feed; `flush()` gives it up (the caller does that
 * after a short wait, so a lone Esc is not held back for long).
 */
export class MouseFilter {
	private held = "";
	/** Inside a bracketed paste: the payload is the person's text, never a click. */
	private inPaste = false;

	feed(chunk: string): { pass: string; events: MouseEvent[] } {
		const s = this.held + chunk;
		this.held = "";
		const events: MouseEvent[] = [];
		let pass = "";
		let rest = s;
		while (rest.length > 0) {
			if (this.inPaste) {
				const end = rest.indexOf(PASTE_END);
				if (end < 0) {
					pass += rest;
					rest = "";
					break;
				}
				pass += rest.slice(0, end + PASTE_END.length);
				rest = rest.slice(end + PASTE_END.length);
				this.inPaste = false;
				continue;
			}
			const start = rest.indexOf(PASTE_START);
			const outside = start < 0 ? rest : rest.slice(0, start);
			pass += outside.replace(SGR_MOUSE, (_m, code, col, row, final) => {
				events.push(parseSgr(Number(code), Number(col), Number(row), final as "M" | "m"));
				return "";
			});
			if (start < 0) {
				rest = "";
				break;
			}
			pass += PASTE_START;
			rest = rest.slice(start + PASTE_START.length);
			this.inPaste = true;
		}
		if (!this.inPaste) {
			const tail = PARTIAL_TAIL.exec(pass);
			if (tail) {
				this.held = tail[0];
				pass = pass.slice(0, tail.index);
			}
		}
		return { pass, events };
	}

	/** Bytes held back as a possible start of a mouse sequence. */
	get pending(): string {
		return this.held;
	}

	flush(): string {
		const h = this.held;
		this.held = "";
		return h;
	}
}

/** Whether the mouse layer turns on for this process. */
export function mouseEnabled(
	env: Record<string, string | undefined> = process.env,
	isTTY: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
	configMouse: string | null = readConfigMouse(),
): boolean {
	if (!isTTY) return false;
	const flag = (env.EIGHT_MOUSE ?? "").toLowerCase();
	if (flag === "0" || flag === "off" || flag === "false" || flag === "no") return false;
	if (configMouse === "off") return false;
	if ((env.TERM ?? "") === "dumb") return false;
	if (env.INK_SCREEN_READER === "true") return false;
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "" && !MOUSE_UNDER_NO_COLOR) return false;
	return true;
}

function readConfigMouse(): string | null {
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const home = process.env.HOME ?? "";
		if (!home) return null;
		const p = path.join(home, ".8gent", "config.json");
		if (!fs.existsSync(p)) return null;
		const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as { mouse?: string };
		return typeof raw.mouse === "string" ? raw.mouse.toLowerCase() : null;
	} catch {
		return null;
	}
}

type Listener = (e: MouseEvent) => void;

interface Installed {
	inject: (bytes: string) => void;
	dispose: () => void;
}

const listeners = new Set<Listener>();
let installed: Installed | null = null;

/** Subscribe to mouse events. Returns the unsubscribe. */
export function onMouse(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function mouseInstalled(): boolean {
	return installed !== null;
}

/**
 * Deliver key bytes to the app as if they were typed: a click on a key cap
 * does exactly what the key does. No-op when the layer is not installed.
 */
export function injectKeys(bytes: string): void {
	installed?.inject(bytes);
}

type PatchableStdin = NodeJS.ReadStream & {
	emit: (event: string | symbol, ...args: unknown[]) => boolean;
	read: (size?: number) => unknown;
};
type Writable = { write: (s: string) => boolean };

/** How long a held partial waits for the rest of its sequence. */
export const HOLD_MS = 25;

/**
 * Install the mouse layer on a stdin/stdout pair. Idempotent: a second call
 * returns the first installation. Returns null when not enabled.
 */
export function installMouse(
	stdin: NodeJS.ReadStream = process.stdin,
	stdout: Writable = process.stdout,
	opts: { enabled?: boolean; processHooks?: boolean } = {},
): Installed | null {
	if (installed) return installed;
	if (!(opts.enabled ?? mouseEnabled())) return null;
	const s = stdin as PatchableStdin;
	const filter = new MouseFilter();
	const origEmit = s.emit.bind(s);
	const origRead = s.read.bind(s);
	/** Bytes to hand Ink untouched on its next read: injected keys, a flushed partial. */
	let queued = "";
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	/** Split UTF-8 characters survive a read boundary. */
	const decoder = new StringDecoder("utf8");
	/** The hold ran out: give the partial up unless the rest arrived meanwhile. */
	let holdExpired = false;
	let wakeScheduled = false;
	/**
	 * Wake the reader so it picks up `queued`: Ink reads in paused mode. Never
	 * synchronously: a click is dispatched from inside Ink's own read loop, and
	 * a nested read there would reorder bytes.
	 */
	const wake = () => {
		if (wakeScheduled) return;
		wakeScheduled = true;
		setImmediate(() => {
			wakeScheduled = false;
			if (s.readableFlowing) s.emit("data", "");
			else origEmit("readable");
		});
	};

	const dispatch = (events: MouseEvent[]) => {
		for (const e of events) for (const l of [...listeners]) l(e);
	};
	const armHold = () => {
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = null;
		if (!filter.pending) return;
		holdTimer = setTimeout(() => {
			holdTimer = null;
			// Do not flush here: the rest of the sequence may be in the stream
			// already. The next read tries fresh bytes first (Codex review #4).
			holdExpired = true;
			wake();
		}, HOLD_MS);
	};
	const filterChunk = (chunk: unknown): string | null => {
		if (chunk == null) return null;
		const str =
			typeof chunk === "string"
				? chunk
				: Buffer.isBuffer(chunk)
					? decoder.write(chunk)
					: String(chunk);
		const { pass, events } = filter.feed(str);
		armHold();
		if (events.length) dispatch(events);
		return pass;
	};

	/** What the reader gets now: bytes queued before this read, then the filtered read. */
	const take = (raw: unknown): string => {
		// Anything a click queues while this chunk is dispatched goes out on the
		// next read, after this chunk's own bytes (Codex review #1).
		const before = queued;
		queued = "";
		let pass = raw == null ? "" : (filterChunk(raw) ?? "");
		if (holdExpired) {
			holdExpired = false;
			if (raw == null) pass += filter.flush();
		}
		return before + pass;
	};
	const patchedRead = (size?: number): unknown => {
		let raw = origRead(size);
		let out = take(raw);
		// A chunk that was only mouse bytes (or half a character) yields nothing:
		// keep reading, because null tells Ink the stream is empty and bytes
		// still buffered would wait for the next keystroke.
		while (out.length === 0 && raw != null) {
			raw = origRead(size);
			out = take(raw);
		}
		return out.length > 0 ? out : null;
	};
	const patchedEmit = (event: string | symbol, ...args: unknown[]): boolean => {
		if (event !== "data" || args.length === 0) return origEmit(event, ...args);
		const out = take(args[0] === "" ? null : args[0]);
		if (out.length === 0) return true;
		return origEmit("data", out, ...args.slice(1));
	};
	s.read = patchedRead as PatchableStdin["read"];
	s.emit = patchedEmit as PatchableStdin["emit"];

	const enable = () => {
		try {
			stdout.write(ENABLE_MOUSE);
		} catch {
			/* stdout closed */
		}
	};
	const disable = () => {
		try {
			// Twice over: a partial write must never leave the shell capturing.
			stdout.write(DISABLE_MOUSE + DISABLE_MOUSE);
		} catch {
			/* stdout closed during exit */
		}
	};
	enable();

	const hooks: Array<[string, (...a: unknown[]) => void]> = [];
	if (opts.processHooks !== false) {
		const onExit = () => disable();
		const tty = s as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (m: boolean) => void };
		let wasRaw = false;
		const onTstp = () => {
			// Leave the shell as it was: no capture, line mode back (Codex review #6).
			disable();
			wasRaw = Boolean(tty.isRaw);
			if (wasRaw) tty.setRawMode?.(false);
			process.kill(process.pid, "SIGSTOP");
		};
		const onCont = () => {
			if (wasRaw) tty.setRawMode?.(true);
			enable();
		};
		// Best effort on a crash, without changing how the crash is handled (#8).
		const onCrash = () => disable();
		// Turn capture off, then let the signal do what it would have done: this
		// listener steps aside and re-raises it when nobody else listens, so the
		// default action still happens (Codex review #7).
		const reraise = (sig: NodeJS.Signals) => {
			const handler = (): void => {
				disable();
				process.removeListener(sig, handler);
				if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
			};
			return handler;
		};
		const onTerm = reraise("SIGTERM");
		const onHup = reraise("SIGHUP");
		const onInt = reraise("SIGINT");
		process.on("exit", onExit);
		process.on("SIGTSTP", onTstp);
		process.on("SIGCONT", onCont);
		process.on("uncaughtExceptionMonitor", onCrash);
		process.on("SIGTERM", onTerm);
		process.on("SIGHUP", onHup);
		process.on("SIGINT", onInt);
		hooks.push(
			["exit", onExit],
			["SIGTSTP", onTstp],
			["SIGCONT", onCont],
			["uncaughtExceptionMonitor", onCrash],
			["SIGTERM", onTerm],
			["SIGHUP", onHup],
			["SIGINT", onInt],
		);
	}

	installed = {
		inject(bytes: string) {
			queued += bytes;
			wake();
		},
		dispose() {
			if (holdTimer) clearTimeout(holdTimer);
			if (s.read === patchedRead) s.read = origRead as PatchableStdin["read"];
			if (s.emit === patchedEmit) s.emit = origEmit as PatchableStdin["emit"];
			for (const [ev, fn] of hooks) process.removeListener(ev, fn as never);
			disable();
			installed = null;
		},
	};
	return installed;
}

/** Tests: tear the layer down. */
export function _disposeMouse(): void {
	installed?.dispose();
	listeners.clear();
}
