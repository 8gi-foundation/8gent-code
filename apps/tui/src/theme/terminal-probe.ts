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
 * back on stdin for Ink to read.
 */

import { type Rgb, toHex } from "../../../../packages/design-compose/index.js";

export const OSC11_QUERY = "\x1b]11;?\x07";
export const DA1_QUERY = "\x1b[c";
export const DEFAULT_PROBE_TIMEOUT_MS = 100;

// The OSC 11 reply. Each channel is 1 to 4 hex digits (xterm scales them to
// the digit count); `rgba:` adds an alpha channel we ignore. Terminated by BEL
// or ST (ESC \).
const OSC11_REPLY =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC, BEL and ST are the protocol.
	/\x1b\]11;(rgba?):([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/([0-9a-fA-F]{1,4}))?(?:\x07|\x1b\\)/;
// DA1 reply: ESC [ ? <params> c
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the protocol.
const DA1_REPLY = /\x1b\[\?[0-9;]*c/;

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

/** Remove the OSC 11 and DA1 replies from `data`, keeping everything else. */
export function stripReplies(data: string): string {
	return data
		.replace(new RegExp(OSC11_REPLY.source, "g"), "")
		.replace(new RegExp(DA1_REPLY.source, "g"), "");
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
	env?: NodeJS.ProcessEnv;
}

/**
 * Query the terminal background. Resolves to `#rrggbb`, or null when the
 * terminal cannot be asked, does not support the query, or does not answer
 * within the timeout. Never rejects.
 */
export function probeTerminalBackground(opts: ProbeOptions = {}): Promise<string | null> {
	const stdin = opts.stdin ?? (process.stdin as ProbeStdin);
	const stdout = opts.stdout ?? (process.stdout as ProbeStdout);
	const env = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

	if (env.EIGHT_OSC11 === "0") return Promise.resolve(null);
	if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
		return Promise.resolve(null);
	}

	return new Promise((resolve) => {
		let buf = "";
		let done = false;
		const wasRaw = stdin.isRaw === true;

		const finish = (hex: string | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			stdin.removeListener("data", onData);
			stdin.pause();
			try {
				if (!wasRaw) stdin.setRawMode?.(false);
			} catch {
				// The terminal went away; nothing to restore.
			}
			const rest = stripReplies(buf);
			if (rest && typeof stdin.unshift === "function") stdin.unshift(Buffer.from(rest, "utf8"));
			resolve(hex);
		};

		const onData = (chunk: Buffer | string) => {
			buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			const hex = parseOsc11Hex(buf);
			if (hex) return finish(hex);
			if (DA1_REPLY.test(buf)) finish(null);
		};

		const timer = setTimeout(() => finish(null), timeoutMs);

		try {
			if (!wasRaw) stdin.setRawMode?.(true);
			stdin.on("data", onData);
			stdin.resume();
			stdout.write(OSC11_QUERY + DA1_QUERY);
		} catch {
			finish(null);
		}
	});
}
