/**
 * /copy: put the last answer on the clipboard (#3918, Pi gap D7).
 *
 * Always through OSC 52, which reaches the local clipboard over SSH and in
 * Windows Terminal, iTerm2, kitty, WezTerm and most modern terminals. Inside
 * tmux or screen the sequence is wrapped so it passes through. On a local
 * session the platform's own copy command runs too, for terminals that ignore
 * OSC 52 (macOS Terminal.app among them).
 */

import { spawnSync } from "node:child_process";
import { osc52 } from "./text-selection.js";

type Env = Record<string, string | undefined>;

export interface ChatLine {
	id?: string;
	role: string;
	content: string;
}

/**
 * The newest answer from the model, or null. Setup questions are drawn as
 * assistant lines too (ids "setup-q-..."), but they are not answers.
 */
export function lastAnswer(messages: readonly ChatLine[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.id?.startsWith("setup-")) continue;
		if (m.role === "assistant" && m.content.trim()) return m.content.trim();
	}
	return null;
}

/** OSC 52 for `text`, wrapped for tmux or screen when running inside one. */
export function clipboardSequence(text: string, env: Env): string {
	const seq = osc52(text);
	if (env.TMUX) return `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
	if (env.STY) return `\x1bP${seq}\x1b\\`;
	return seq;
}

/** The local copy command, or null over SSH or when there is none. */
export function nativeCopyArgv(platform: string, env: Env, text?: string): string[] | null {
	if (env.SSH_CONNECTION || env.SSH_TTY) return null;
	if (platform === "darwin") return ["pbcopy"];
	if (platform === "linux") {
		if (env.WAYLAND_DISPLAY) return ["wl-copy"];
		if (env.DISPLAY) return ["xclip", "-selection", "clipboard"];
	}
	// Windows: clip.exe mangles non-ASCII text, so it only takes plain ASCII;
	// Windows Terminal takes the rest through OSC 52.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
	if (platform === "win32" && text !== undefined && /^[\x00-\x7f]*$/.test(text))
		return ["clip.exe"];
	return null;
}

export interface CopyDeps {
	write: (seq: string) => void;
	env?: Env;
	platform?: string;
	runNative?: (argv: string[], text: string) => boolean;
}

function runNativeCopy(argv: string[], text: string): boolean {
	try {
		const r = spawnSync(argv[0], argv.slice(1), {
			input: text,
			timeout: 2000,
			stdio: ["pipe", "ignore", "ignore"],
		});
		return r.status === 0;
	} catch {
		return false;
	}
}

/**
 * Most base64 sent in one OSC 52 sequence. Terminals cap it (xterm ~100 KB,
 * tmux and others less) and drop or truncate anything bigger.
 */
export const OSC52_MAX_ENCODED = 100_000;

export function osc52Fits(text: string): boolean {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 3) * 4 <= OSC52_MAX_ENCODED;
}

export interface CopyResult {
	/** OSC 52 was written to the terminal. */
	osc52: boolean;
	/** The local copy command that took the text, if any. */
	native: string | null;
}

/** Copy `text`: OSC 52 when it fits, plus the local copy command when there is one. */
export function copyText(text: string, deps: CopyDeps): CopyResult {
	const env = deps.env ?? process.env;
	let osc52 = false;
	if (osc52Fits(text)) {
		try {
			deps.write(clipboardSequence(text, env));
			osc52 = true;
		} catch {
			/* stdout closed */
		}
	}
	const argv = nativeCopyArgv(deps.platform ?? process.platform, env, text);
	const native = argv && (deps.runNative ?? runNativeCopy)(argv, text) ? argv[0] : null;
	return { osc52, native };
}

/** The chat line /copy prints. */
export function copyReply(messages: readonly ChatLine[], deps: CopyDeps): string {
	const answer = lastAnswer(messages);
	if (!answer) return "Nothing to copy yet: no answer in this chat.";
	const r = copyText(answer, deps);
	const n = answer.length;
	const size = `${n} character${n === 1 ? "" : "s"}`;
	const tooBig = `too long for the terminal clipboard (over ${OSC52_MAX_ENCODED / 1000} KB encoded)`;
	if (r.native && r.osc52) return `Copied the last answer (${size}).`;
	if (r.native)
		return `Copied the last answer (${size}) with ${r.native}. It is ${tooBig}, so it was not sent to the terminal.`;
	if (r.osc52) return `Sent the last answer to the clipboard (${size}).`;
	return `Nothing copied: the last answer (${size}) is ${tooBig}, and there is no local copy command here.`;
}
