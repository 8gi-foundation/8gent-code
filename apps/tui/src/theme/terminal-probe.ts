/**
 * Ask the terminal for its real background colour (#3754).
 *
 * xterm's OSC 11 query: write `ESC ] 11 ; ? BEL` and a terminal that supports
 * it answers `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` followed by BEL or ST. Spec:
 * https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (Operating System
 * Commands, "Ps = 1 1  Change VT100 text background color", "?" queries it).
 *
 * A Primary Device Attributes request (`ESC [ c`) is written straight after.
 * Every VT100-compatible terminal answers DA1, and terminals answer in order,
 * so a DA1 reply with no OSC 11 reply before it means "this terminal does not
 * do OSC 11" and the probe ends at once instead of waiting for the timeout.
 *
 * It never blocks a run that has no human at a terminal: no TTY on stdin or
 * stdout, no setRawMode, or EIGHT_OSC11=0 returns null without writing a
 * byte. A terminal that answers nothing is cut off by the timeout (100 ms).
 * Any byte that is not part of a reply (a key pressed during startup) is put
 * back on stdin for Ink to read; a reply fragment never is.
 *
 * Late or split replies (a terminal answering after the timeout, or a reply
 * cut across reads) would otherwise reach the prompt as text. So for a short
 * window after the probe, stdin.read is wrapped by a filter that strips OSC 11
 * and DA1 replies and holds back a trailing partial one (#3764).
 *
 * SYSTEM THEME (#4440): the opt-in `system` theme also wants the terminal's
 * own palette. `palette: true` adds OSC 10 (foreground), OSC 4 (the 16 ANSI
 * slots) and a DECRQM check for DEC mode 2031 (colour-scheme notifications)
 * to the same DA1-bounded window, so a terminal that swallows them costs the
 * same 100 ms cap as before and a terminal that answers costs nothing extra.
 * Nothing extra is written unless the theme is selected. followTerminalScheme
 * keeps a stdin filter for the life of the run so a 2031 notice or a late
 * colour reply never reaches the input box, and re-asks on each notice.
 */

import { StringDecoder } from "node:string_decoder";
import { type Rgb, toHex } from "../../../../packages/design-compose/index.js";
import { bootTrace } from "../lib/boot-trace.js";

export const OSC11_QUERY = "\x1b]11;?\x07";
export const DA1_QUERY = "\x1b[c";
export const DEFAULT_PROBE_TIMEOUT_MS = 100;
/** OSC 10 (foreground) plus OSC 4 for ANSI slots 0 to 15. */
export const PALETTE_QUERY = `\x1b]10;?\x07${Array.from({ length: 16 }, (_, i) => `\x1b]4;${i};?\x07`).join("")}`;
/** DECRQM for DEC mode 2031: does the terminal report light/dark switches. */
export const SCHEME_SUPPORT_QUERY = "\x1b[?2031$p";
export const SCHEME_SUBSCRIBE = "\x1b[?2031h";
export const SCHEME_UNSUBSCRIBE = "\x1b[?2031l";
/** A live re-query after a scheme notice gives up after this long. */
export const FOLLOW_TIMEOUT_MS = 150;
/** How long after the probe late replies are still filtered out of stdin. */
export const LATE_REPLY_WINDOW_MS = 1000;

// The OSC 11 reply. Each channel is 1 to 4 hex digits (xterm scales them to
// the digit count); `rgba:` adds an alpha channel we ignore. Terminated by BEL
// or ST (ESC \).
const OSC11_REPLY =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC, BEL and ST are the protocol.
	/\x1b\]11;(rgba?):([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/([0-9a-fA-F]{1,4}))?(?:\x07|\x1b\\)/;
// DA1 reply: ESC [ ? <params> c
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the protocol.
const DA1_REPLY = /\x1b\[\?[0-9;]*c/;

// Any colour reply we ask for: OSC 4;n, OSC 10, OSC 11.
const COLOR_REPLY_SRC =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC, BEL and ST are the protocol.
	/\x1b\](4;\d{1,3}|10|11);(rgba?):([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/([0-9a-fA-F]{1,4}))?(?:\x07|\x1b\\)/
		.source;
// DECRPM for mode 2031: ESC [ ? 2031 ; Ps $ y  (Ps 1 or 2 = the terminal knows the mode).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the protocol.
const DECRPM_REPLY = /\x1b\[\?2031;[0-4]\$y/;
// Colour-scheme notice: ESC [ ? 997 ; 1 n (dark) or ; 2 n (light).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the protocol.
const SCHEME_NOTICE = /\x1b\[\?997;([12])n/;
const ANY_REPLY_SRC = `${COLOR_REPLY_SRC}|${DECRPM_REPLY.source}|${SCHEME_NOTICE.source}`;

function channel(hex: string): number {
	return Number.parseInt(hex, 16) / (16 ** hex.length - 1);
}

/** Parse an OSC 11 reply (anywhere in `data`) to an sRGB colour, or null. */
export function parseOsc11(data: string): Rgb | null {
	const m = OSC11_REPLY.exec(data);
	if (!m) return null;
	if (m[1] === "rgb" && m[5] !== undefined) return null; // rgb: with 4 channels is malformed
	if (m[1] === "rgba" && m[5] === undefined) return null;
	return { r: channel(m[2]), g: channel(m[3]), b: channel(m[4]) };
}

/** Same as parseOsc11, as a #rrggbb string. */
export function parseOsc11Hex(data: string): string | null {
	const rgb = parseOsc11(data);
	return rgb ? toHex(rgb) : null;
}

/** What a palette probe learned. Slots the terminal did not answer are null. */
export interface TerminalReport {
	bg: string | null;
	fg: string | null;
	/** The 16 ANSI slots, as #rrggbb. */
	ansi: (string | null)[];
	/** True when the terminal says it reports colour-scheme switches (DEC 2031). */
	schemeNotify: boolean;
}

/** Parse every colour and DECRPM reply found in `data`. Never throws. */
export function parseTerminalReport(data: string): TerminalReport {
	const r: TerminalReport = {
		bg: null,
		fg: null,
		ansi: new Array(16).fill(null),
		schemeNotify: false,
	};
	for (const m of data.matchAll(new RegExp(COLOR_REPLY_SRC, "g"))) {
		if (m[2] === "rgb" && m[6] !== undefined) continue;
		if (m[2] === "rgba" && m[6] === undefined) continue;
		const hex = toHex({ r: channel(m[3]), g: channel(m[4]), b: channel(m[5]) });
		if (m[1] === "11") r.bg = hex;
		else if (m[1] === "10") r.fg = hex;
		else {
			const n = Number.parseInt(m[1].slice(2), 10);
			if (n >= 0 && n < 16) r.ansi[n] = hex;
		}
	}
	const d = /\x1b\[\?2031;([0-4])\$y/.exec(data);
	r.schemeNotify = d !== null && (d[1] === "1" || d[1] === "2");
	return r;
}

/** Remove the colour, DA1, DECRPM and scheme-notice replies from `data`, keeping everything else. */
export function stripReplies(data: string): string {
	return data
		.replace(new RegExp(ANY_REPLY_SRC, "g"), "")
		.replace(new RegExp(DA1_REPLY.source, "g"), "");
}

/**
 * Split off a trailing, unterminated OSC or DA1 reply. A lone ESC (the Escape
 * key) or an ESC [ that is not ESC [ ? (arrow keys) is never held.
 */
export function splitTrailingPartial(data: string): [clean: string, partial: string] {
	const osc = data.lastIndexOf("\x1b]");
	if (osc >= 0) {
		const tail = data.slice(osc);
		if (!tail.includes("\x07") && !tail.includes("\x1b\\")) return [data.slice(0, osc), tail];
	}
	const da1 = data.lastIndexOf("\x1b[?");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the protocol.
	if (da1 >= 0 && /^\x1b\[\?[0-9;]*\$?$/.test(data.slice(da1)))
		return [data.slice(0, da1), data.slice(da1)];
	return [data, ""];
}

/** A held fragment longer than this is not a reply; it is released as typed text. */
export const MAX_HELD_REPLY = 64;

/** Strips complete replies from a stream of text and holds back a partial one. */
export class ReplyFilter {
	private held: string;
	constructor(
		held = "",
		private onReply?: (reply: string) => void,
	) {
		this.held = held;
	}
	push(chunk: string): string {
		const joined = this.held + chunk;
		if (this.onReply) {
			for (const m of joined.matchAll(new RegExp(`${ANY_REPLY_SRC}|${DA1_REPLY.source}`, "g")))
				this.onReply(m[0]);
		}
		const [clean, partial] = splitTrailingPartial(stripReplies(joined));
		if (partial.length > MAX_HELD_REPLY) {
			this.held = "";
			return clean + partial;
		}
		this.held = partial;
		return clean;
	}
	/** Give up the held fragment: it was typed text (Alt+], a pasted partial), not a reply. */
	release(): string {
		const h = this.held;
		this.held = "";
		return h;
	}
	/** What is held back right now (a reply fragment). */
	get pending(): string {
		return this.held;
	}
}

type ReadableLike = { read?: (size?: number) => unknown };

/**
 * Wrap stdin.read for `windowMs` so replies that arrive late or split never
 * reach Ink. After the window it is a pass-through and anything still held
 * (by construction a reply fragment) is dropped, never delivered.
 *
 * `typed` is the text the probe put back on stdin (keys pressed while it
 * waited). It is read first and delivered ahead of the filter, so a reply
 * fragment held from the probe can never swallow it.
 */
export function installLateReplyFilter(
	stdin: ReadableLike,
	held: string,
	windowMs = LATE_REPLY_WINDOW_MS,
	now: () => number = Date.now,
	typed = "",
	onReply?: (reply: string) => void,
	flushMs = 0,
): void {
	if (typeof stdin.read !== "function") return;
	const orig = stdin.read.bind(stdin);
	const filter = new ReplyFilter(held, onReply);
	const decoder = new StringDecoder("utf8");
	const until = now() + windowMs;
	let open = true;
	let bypass = typed.length;
	// A held fragment with no timer would swallow typing until 64 bytes pile up.
	// With flushMs, a fragment still held after that long goes back to stdin as
	// typed text, passed through unfiltered (bypass) so it is not held again.
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const armFlush = () => {
		clearTimeout(flushTimer);
		if (!flushMs || !filter.pending) return;
		flushTimer = setTimeout(() => {
			const text = filter.release();
			const un = (stdin as { unshift?: (c: Buffer) => void }).unshift;
			if (!text || typeof un !== "function") return;
			bypass += text.length;
			un.call(stdin, Buffer.from(text, "utf8"));
		}, flushMs);
		flushTimer.unref?.();
	};
	stdin.read = (size?: number) => {
		if (open && now() > until) {
			open = false;
			const tail = decoder.end(); // a split multi-byte key, not a reply
			const v = orig(size);
			if (!tail) return v;
			if (v === null || v === undefined) return Buffer.from(tail, "utf8");
			return typeof v === "string"
				? tail + v
				: Buffer.concat([Buffer.from(tail, "utf8"), v as Buffer]);
		}
		if (!open) return orig(size);
		for (;;) {
			const v = orig(size);
			if (v === null || v === undefined) return v;
			const str = typeof v === "string" ? v : Buffer.isBuffer(v) ? decoder.write(v) : null;
			if (str === null) return v;
			const pass = str.slice(0, bypass);
			bypass -= pass.length;
			const rest = str.slice(pass.length);
			const out = pass + (rest ? filter.push(rest) : "");
			armFlush();
			if (out) return typeof v === "string" ? out : Buffer.from(out, "utf8");
		}
	};
}

type ProbeStdin = NodeJS.ReadableStream & {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => unknown;
	unshift?: (chunk: Buffer | string) => void;
};
type ProbeStdout = { isTTY?: boolean; write: (s: string) => unknown };

export interface ProbeOptions {
	stdin?: ProbeStdin;
	stdout?: ProbeStdout;
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
	/** Late-reply filter window after the probe; 0 turns it off. */
	lateFilterMs?: number;
	/** Also ask for the foreground, the 16 ANSI slots and DEC 2031 support (#4440). */
	palette?: boolean;
}

// The system theme asks for the palette before Ink mounts, but index.tsx only
// calls probeTerminalBackground(). theme.ts sets the flag at load when the
// saved choice is `system`; nobody else sets it, so every other run writes the
// same bytes as before. The report waits here for applyTerminalBackground.
let paletteRequested = false;
let lastReport: TerminalReport | null = null;
export function requestPaletteProbe(): void {
	paletteRequested = true;
}
/** The report of the last palette probe, once. */
export function takeTerminalReport(): TerminalReport | null {
	const r = lastReport;
	lastReport = null;
	return r;
}

/**
 * Query the terminal background. Resolves to `#rrggbb`, or null when the
 * terminal cannot be asked, does not support the query, or does not answer
 * within the timeout. Never rejects.
 */
export async function probeTerminalBackground(opts: ProbeOptions = {}): Promise<string | null> {
	const palette = opts.palette ?? paletteRequested;
	const report = await probeTerminal({ ...opts, palette });
	if (palette) lastReport = report;
	return report?.bg ?? null;
}

/** The probe itself: a report (bg null when unanswered), or null when the terminal cannot be asked. */
export function probeTerminal(opts: ProbeOptions = {}): Promise<TerminalReport | null> {
	const stdin = opts.stdin ?? (process.stdin as ProbeStdin);
	const stdout = opts.stdout ?? (process.stdout as ProbeStdout);
	const env = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

	if (env.EIGHT_OSC11 === "0") return Promise.resolve(null);
	if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
		return Promise.resolve(null);
	}

	const lateFilterMs = opts.lateFilterMs ?? LATE_REPLY_WINDOW_MS;

	return new Promise((resolve) => {
		let buf = "";
		const decoder = new StringDecoder("utf8");
		let done = false;
		const wasRaw = stdin.isRaw === true;

		// Hand stdin back to Ink: stop listening, pause, put typed bytes back.
		const settle = () => {
			bootTrace("terminal-probe-end", `replyBytes=${buf.length}`);
			stdin.removeListener("data", onData);
			stdin.pause();
			try {
				if (!wasRaw) stdin.setRawMode?.(false);
			} catch {
				// The terminal went away; nothing to restore.
			}
			const [clean, partial] = splitTrailingPartial(stripReplies(buf));
			if (clean && typeof stdin.unshift === "function") stdin.unshift(Buffer.from(clean, "utf8"));
			const unshifted = Boolean(clean) && typeof stdin.unshift === "function";
			if (lateFilterMs > 0) {
				installLateReplyFilter(
					stdin as ReadableLike,
					partial,
					lateFilterMs,
					Date.now,
					unshifted ? clean : "",
				);
			}
			resolve(parseTerminalReport(buf));
		};

		// A reply that arrives at once (a multiplexer, a local emulator) ends the
		// probe from inside the 'data' event. Pausing stdin there leaves Bun's
		// stream deaf: Ink's later 'readable' listener never fires and no key is
		// ever read. So a probe ended by data settles one macrotask later, outside
		// the event, and keeps collecting bytes until then so none is dropped.
		// A probe ended by the timeout is already outside any event.
		const finish = (fromData = false) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (fromData) setImmediate(settle);
			else settle();
		};

		const onData = (chunk: Buffer | string) => {
			buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
			if (done) return; // settling: keep the byte, decide nothing
			// A palette probe waits for DA1: terminals answer in order, so it
			// closes the window with every reply before it already in `buf`.
			if (!opts.palette && parseOsc11Hex(buf)) return finish(true);
			if (DA1_REPLY.test(buf)) finish(true);
		};

		const timer = setTimeout(finish, timeoutMs);
		bootTrace("terminal-probe-start", `wasRaw=${wasRaw}`);

		try {
			if (!wasRaw) stdin.setRawMode?.(true);
			stdin.on("data", onData);
			stdin.resume();
			stdout.write(
				OSC11_QUERY + (opts.palette ? PALETTE_QUERY + SCHEME_SUPPORT_QUERY : "") + DA1_QUERY,
			);
		} catch {
			finish();
		}
	});
}

/** A held reply fragment older than this is released as typed text. */
export const FILTER_FLUSH_MS = 50;
const replySlots = new WeakMap<object, { handler: (reply: string) => void }>();

export interface SchemeFollower {
	/** Ask again now (a scheme notice, or the user picked the theme). */
	refresh(): void;
	/** Unsubscribe from DEC 2031. The stdin filter stays: it only strips replies. */
	stop(): void;
}

/**
 * Keep the system theme in step with the terminal (#4440). Installs a
 * never-expiring reply filter on stdin (so a notice or a reply that lands
 * after Ink mounted is stripped, never typed), re-queries on each DEC 2031
 * notice, and calls `onReport` with the answer. The terminal is asked only
 * after the user chose the system theme; one that does not report 2031 is
 * re-asked on refresh() only. Null when there is no TTY or EIGHT_OSC11=0.
 */
export function followTerminalScheme(
	onReport: (r: TerminalReport) => void,
	opts: Pick<ProbeOptions, "stdin" | "stdout" | "env" | "timeoutMs"> = {},
): SchemeFollower | null {
	const stdin = opts.stdin ?? (process.stdin as ProbeStdin);
	const stdout = opts.stdout ?? (process.stdout as ProbeStdout);
	const env = opts.env ?? process.env;
	if (env.EIGHT_OSC11 === "0" || !stdin.isTTY || !stdout.isTTY) return null;
	const timeoutMs = opts.timeoutMs ?? FOLLOW_TIMEOUT_MS;
	let collected: string | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let subscribed = false;
	let stopped = false;

	const flush = () => {
		if (collected === null) return;
		clearTimeout(timer);
		const report = parseTerminalReport(collected);
		collected = null;
		if (stopped) return;
		if (report.schemeNotify && !subscribed) {
			subscribed = true;
			stdout.write(SCHEME_SUBSCRIBE);
		}
		if (report.bg) onReport(report);
	};
	const refresh = () => {
		if (stopped || collected !== null) return;
		collected = "";
		timer = setTimeout(flush, timeoutMs);
		stdout.write(OSC11_QUERY + PALETTE_QUERY + SCHEME_SUPPORT_QUERY + DA1_QUERY);
	};
	const onReply = (reply: string) => {
		if (SCHEME_NOTICE.test(reply)) return refresh();
		if (collected === null) return;
		collected += reply;
		if (DA1_REPLY.test(reply)) flush();
	};
	// One filter per stdin for the life of the process: a second one would stack
	// under the first and eat the replies the first passes on. Each follower
	// just takes over the handler.
	let slot = replySlots.get(stdin);
	if (!slot) {
		const created: { handler: (reply: string) => void } = { handler: () => {} };
		slot = created;
		replySlots.set(stdin, created);
		installLateReplyFilter(
			stdin as ReadableLike,
			"",
			Number.POSITIVE_INFINITY,
			Date.now,
			"",
			(reply) => created.handler(reply),
			FILTER_FLUSH_MS,
		);
	}
	slot.handler = onReply;
	const mine = slot;
	const stop = () => {
		if (mine.handler === onReply) mine.handler = () => {};
		if (subscribed) stdout.write(SCHEME_UNSUBSCRIBE);
		subscribed = false;
		stopped = true;
		clearTimeout(timer);
	};
	process.once("exit", () => {
		if (subscribed) stdout.write(SCHEME_UNSUBSCRIBE);
	});
	return { refresh, stop };
}
