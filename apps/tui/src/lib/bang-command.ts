/**
 * `!cmd` and `!!cmd` in the prompt (#3918, Pi gap D5).
 *
 * `!cmd` runs a shell command in the project folder, shows its output in the
 * chat, and sends that output to the model with your next message. `!!cmd`
 * runs it and only shows it. The command is yours, typed by you, so it runs
 * like a line in your own terminal: no approval card.
 */

import { killProcessTree, spawnShell } from "../../../../packages/core/shell.js";

export interface BangCommand {
	command: string;
	/** true for `!cmd`: the output goes to the model with the next message. */
	send: boolean;
}

/** `!cmd` or `!!cmd`, or null when the input is not a shell line. */
export function parseBang(input: string): BangCommand | null {
	const t = input.trim();
	if (!t.startsWith("!")) return null;
	const send = !t.startsWith("!!");
	return { command: t.slice(send ? 1 : 2).trim(), send };
}

export interface BangResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

export const BANG_TIMEOUT_MS = 120_000;
/** Most output kept from one command; the start is dropped, the end kept. */
export const BANG_MAX_CHARS = 16_000;

function keepTail(s: string, max: number): string {
	return s.length <= max ? s : `[first ${s.length - max} characters cut]\n${s.slice(-max)}`;
}

/** Run `command` through the platform shell in `cwd`; stdout and stderr together. */
export function runBang(
	command: string,
	cwd: string,
	timeoutMs = BANG_TIMEOUT_MS,
): Promise<BangResult> {
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		const proc = spawnShell(command, {
			cwd,
			processGroup: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const take = (d: Buffer) => {
			output += d.toString("utf8");
			if (output.length > BANG_MAX_CHARS * 2) output = output.slice(-BANG_MAX_CHARS * 2);
		};
		proc.stdout?.on("data", take);
		proc.stderr?.on("data", take);
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(proc.pid, "SIGKILL");
		}, timeoutMs);
		const done = (exitCode: number | null) => {
			clearTimeout(timer);
			resolve({ exitCode, output: keepTail(output.trimEnd(), BANG_MAX_CHARS), timedOut });
		};
		proc.on("error", (err) => {
			output += String(err.message);
			done(null);
		});
		proc.on("close", (code) => done(code));
	});
}

function status(r: BangResult): string {
	if (r.timedOut) return `stopped after ${BANG_TIMEOUT_MS / 1000} s`;
	return r.exitCode === null ? "did not start" : `exit ${r.exitCode}`;
}

/** The chat line: the command, the end of its output, how it ended, where it goes. */
export function bangChatLine(b: BangCommand, r: BangResult, maxLines = 40): string {
	const lines = r.output ? r.output.split("\n") : [];
	const shown =
		lines.length > maxLines
			? [`... ${lines.length - maxLines} lines above`, ...lines.slice(-maxLines)]
			: lines;
	const tail = b.send ? "Goes to 8gent with your next message." : "Not sent to 8gent.";
	return [`$ ${b.command}`, ...shown, `(${status(r)}) ${tail}`].join("\n");
}

/** What the model reads before your next message. */
export function bangContextBlock(b: BangCommand, r: BangResult): string {
	return `I ran \`${b.command}\` in the shell (${status(r)}). Output:\n\`\`\`\n${r.output}\n\`\`\``;
}

/** Your message with any pending shell output in front of it. */
export function withShellContext(blocks: readonly string[] | undefined, message: string): string {
	return blocks?.length ? `${blocks.join("\n\n")}\n\n${message}` : message;
}

export const BANG_USAGE =
	"!<command> runs it here and sends the output with your next message. !!<command> runs it without sending.";
