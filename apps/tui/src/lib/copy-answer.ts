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
import { osc52 } from "./mouse-wiring.js";

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
export function nativeCopyArgv(platform: string, env: Env): string[] | null {
	if (env.SSH_CONNECTION || env.SSH_TTY) return null;
	if (platform === "darwin") return ["pbcopy"];
	if (platform === "linux") {
		if (env.WAYLAND_DISPLAY) return ["wl-copy"];
		if (env.DISPLAY) return ["xclip", "-selection", "clipboard"];
	}
	// Windows: clip.exe mangles non-ASCII text; Windows Terminal takes OSC 52.
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

/** Copy `text`. Returns the name of the native command that also took it, if any. */
export function copyText(text: string, deps: CopyDeps): { native: string | null } {
	const env = deps.env ?? process.env;
	try {
		deps.write(clipboardSequence(text, env));
	} catch {
		/* stdout closed */
	}
	const argv = nativeCopyArgv(deps.platform ?? process.platform, env);
	if (!argv) return { native: null };
	return { native: (deps.runNative ?? runNativeCopy)(argv, text) ? argv[0] : null };
}

/** The chat line /copy prints. */
export function copyReply(messages: readonly ChatLine[], deps: CopyDeps): string {
	const answer = lastAnswer(messages);
	if (!answer) return "Nothing to copy yet: no answer in this chat.";
	copyText(answer, deps);
	const n = answer.length;
	return `Copied the last answer (${n} character${n === 1 ? "" : "s"}).`;
}
