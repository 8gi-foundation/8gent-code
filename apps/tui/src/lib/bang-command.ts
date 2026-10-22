/**
 * `!cmd` and `!!cmd` in the prompt (#3918, Pi gap D5).
 *
 * `!cmd` runs a shell command in the project folder, shows its output in the
 * chat, and sends that output to the model with your next message. `!!cmd`
 * runs it and only shows it. The command is yours, typed by you, so it runs
 * like a line in your own terminal: no approval card. Plan mode runs nothing.
 *
 * Output is cleaned before anyone sees it: terminal control bytes go, and
 * provider secrets are redacted (packages/eight/secret-scanner). Commands that
 * touch 8gent's own settings, audit files, session records or browser
 * secrets still run, but their output is never sent. The chat lines these
 * write are never saved into the session file.
 */

import { killProcessTree, spawnShell } from "../../../../packages/core/shell.js";
import { scrub } from "../../../../packages/eight/secret-scanner.js";
import {
	commandMutatesSessionRecords,
	commandTouchesAuditFiles,
} from "../../../../packages/permissions/path-guard.js";
import {
	type PermissionMode,
	isPermissionMode,
} from "../../../../packages/permissions/permission-mode.js";
import { touchesBrowserSecrets } from "../../../../packages/tools/eight-browser.js";
import { CONSULT_ID_PREFIX } from "./consult-command.js";

export interface BangCommand {
	command: string;
	/** true for `!cmd`: the output goes to the model with the next message. */
	send: boolean;
}

/** Chat lines from `!cmd` carry this id prefix; session saves leave them out. */
export const BANG_ID_PREFIX = "bang-";

/** `!cmd` or `!!cmd`, or null when the input is not a shell line. */
export function parseBang(input: string): BangCommand | null {
	const t = input.trim();
	if (!t.startsWith("!")) return null;
	const send = !t.startsWith("!!");
	return { command: t.slice(send ? 1 : 2).trim(), send };
}

/**
 * Why this command's output must not go to the model, or null. The same four
 * pre-spawn backstops run_command applies (#3993; switch to preSpawnRefusal
 * from packages/permissions/pre-spawn-backstops once #3997 lands).
 */
// Files that hold credentials. Their output is never sent: the secret scanner
// misses many names (OPENAI_API_KEY=... in a .env, #3203), so this does not
// rely on it.
const CREDENTIAL_FILES = /(^|[\s/'"])\.env(\.|\b)|\.npmrc|\.netrc|credentials|id_[a-z0-9]+(\b|$)/i;

export function sendRefusal(command: string): string | null {
	if (CREDENTIAL_FILES.test(command)) return "it reads a credentials file";
	if (
		/\.8gent\S*\s*[/\\]+\s*settings/i.test(command) ||
		/\.8gent["']?\s*[/\\]["']?settings/i.test(command)
	)
		return "it touches ~/.8gent/settings.json";
	if (commandTouchesAuditFiles(command)) return "it touches 8gent's audit files";
	if (commandMutatesSessionRecords(command)) return "it changes session records";
	if (touchesBrowserSecrets(command)) return "it touches 8gent Browser control tokens or profiles";
	return null;
}

/**
 * Plan mode runs nothing, `!cmd` included. Null when the mode allows it.
 * The way out leads with /mode ask: a phone keyboard (Termux) has no
 * Shift+Tab, and the footer's ^Y is the work mode (Planning, Researching...),
 * not the permission mode, so it never leaves Plan.
 */
export function planModeRefusal(mode: string): string | null {
	return mode === "plan"
		? "Plan mode runs nothing, shell lines included. Type /mode ask (or press Shift+Tab) to change mode, then run it again."
		: null;
}

/**
 * `/mode <name>`: the permission mode asked for. Null, so nothing changes,
 * with no name, an unknown name, or anything after the name.
 */
export function parseModeArgs(args: readonly string[]): PermissionMode | null {
	const words = args.flatMap((a) => a.trim().split(/\s+/)).filter(Boolean);
	if (words.length !== 1) return null;
	const name = words[0].toLowerCase();
	return isPermissionMode(name) ? name : null;
}

export const MODE_USAGE =
	"Usage: /mode plan | ask | guarded | infinite (this tab's permission mode).";

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control bytes is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control bytes is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Output safe to draw and to send: no ESC sequences or C0 bytes but \n and \t; secrets redacted. */
export function cleanOutput(raw: string): { text: string; redacted: number } {
	const plain = raw.replace(/\r\n/g, "\n").replace(ANSI, "").replace(CONTROL, "");
	const r = scrub(plain);
	return { text: r.scrubbed, redacted: r.redactedCount };
}

export interface BangResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
	/** Secrets the scanner replaced in the output. */
	redacted: number;
}

export interface BangRun {
	done: Promise<BangResult>;
	/** Stop the command and everything it started. */
	cancel: () => void;
}

export const BANG_TIMEOUT_MS = 120_000;
/** Most output kept from one command; the start is dropped, the end kept. */
export const BANG_MAX_CHARS = 16_000;

function keepTail(s: string, max: number): string {
	return s.length <= max ? s : `[first ${s.length - max} characters cut]\n${s.slice(-max)}`;
}

/** Start `command` through the platform shell in `cwd`; stdout and stderr together. */
export function startBang(command: string, cwd: string, timeoutMs = BANG_TIMEOUT_MS): BangRun {
	let output = "";
	let timedOut = false;
	let cancelled = false;
	let finished = false;
	const proc = spawnShell(command, { cwd, processGroup: true, stdio: ["ignore", "pipe", "pipe"] });
	const kill = () => {
		if (!finished) killProcessTree(proc.pid, "SIGKILL");
	};
	const done = new Promise<BangResult>((resolve) => {
		const take = (d: Buffer) => {
			output += d.toString("utf8");
			if (output.length > BANG_MAX_CHARS * 2) output = output.slice(-BANG_MAX_CHARS * 2);
		};
		proc.stdout?.on("data", take);
		proc.stderr?.on("data", take);
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const end = (exitCode: number | null) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			const clean = cleanOutput(output.trimEnd());
			resolve({
				exitCode,
				output: keepTail(clean.text, BANG_MAX_CHARS),
				timedOut,
				cancelled,
				redacted: clean.redacted,
			});
		};
		proc.on("error", (err) => {
			output += String(err.message);
			end(null);
		});
		proc.on("close", (code) => end(code));
	});
	return {
		done,
		cancel: () => {
			cancelled = true;
			kill();
		},
	};
}

/** Run `command` to the end (or the timeout). */
export function runBang(
	command: string,
	cwd: string,
	timeoutMs = BANG_TIMEOUT_MS,
): Promise<BangResult> {
	return startBang(command, cwd, timeoutMs).done;
}

function status(r: BangResult): string {
	if (r.cancelled) return "stopped";
	if (r.timedOut) return `stopped after ${BANG_TIMEOUT_MS / 1000} s`;
	return r.exitCode === null ? "did not start" : `exit ${r.exitCode}`;
}

/** The line shown while the command runs. */
export function bangRunningLine(b: BangCommand): string {
	return `$ ${b.command}\n(running, Esc to stop)`;
}

/**
 * The chat line: the command, the end of its output, how it ended, and where
 * the output goes. `withheld` says why `!cmd` output was not sent.
 */
export function bangChatLine(
	b: BangCommand,
	r: BangResult,
	withheld: string | null = null,
	maxLines = 40,
): string {
	const lines = r.output ? r.output.split("\n") : [];
	const shown =
		lines.length > maxLines
			? [`... ${lines.length - maxLines} lines above`, ...lines.slice(-maxLines)]
			: lines;
	const where = !b.send
		? "Not sent to 8gent."
		: withheld
			? `Not sent to 8gent: ${withheld}.`
			: r.cancelled
				? "Not sent to 8gent."
				: "Goes to 8gent with your next message.";
	const secrets =
		r.redacted > 0 ? ` ${r.redacted} secret${r.redacted === 1 ? "" : "s"} redacted.` : "";
	return [`$ ${b.command}`, ...shown, `(${status(r)}) ${where}${secrets}`].join("\n");
}

/** A backtick fence longer than any run of backticks in `text`, so it cannot be closed early. */
export function fenceFor(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

/** What the model reads before your next message: command output, marked as not the user's words. */
export function bangContextBlock(b: BangCommand, r: BangResult): string {
	const fence = fenceFor(`${b.command}\n${r.output}`);
	return [
		`[Shell command output. The user ran this command; the output below is the command's, not words the user wrote.]`,
		`Command: ${b.command} (${status(r)})`,
		`${fence}text`,
		r.output,
		fence,
	].join("\n");
}

/** Your message with any pending shell output in front of it. */
export function withShellContext(blocks: readonly string[] | undefined, message: string): string {
	return blocks?.length ? `${blocks.join("\n\n")}\n\n${message}` : message;
}

/** The parts of `process` that killBangsOnExit uses. */
export interface SignalHost {
	on(event: string, fn: () => void): unknown;
	removeListener(event: string, fn: () => void): unknown;
	listenerCount(event: string): number;
	kill(pid: number, signal: string): unknown;
	pid: number;
}

/**
 * Stop every running `!cmd` when the process exits or gets SIGTERM or SIGHUP.
 * On a signal the handler removes itself and, if no other handler is left,
 * raises the signal again so the process still ends (the same pattern as
 * lib/mouse-input.ts, which re-raises SIGTERM). Returns the uninstaller.
 */
export function killBangsOnExit(
	stop: () => void,
	host: SignalHost = process as unknown as SignalHost,
): () => void {
	const onExit = () => stop();
	const handlers = (["SIGTERM", "SIGHUP"] as const).map((sig) => {
		const fn = (): void => {
			stop();
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

/** Messages to save: everything except `!cmd` chat lines and /consult lines (their replies hold unmasked values). */
export function withoutBangLines<T extends { id?: string }>(messages: readonly T[]): T[] {
	return messages.filter(
		(m) => !m.id?.startsWith(BANG_ID_PREFIX) && !m.id?.startsWith(CONSULT_ID_PREFIX),
	);
}

export const BANG_USAGE =
	"!<command> runs it here and sends the output with your next message. !!<command> runs it without sending.";
