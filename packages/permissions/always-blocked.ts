/**
 * The always-blocked check (#3768): which commands a line runs, and whether
 * any of them is a catastrophic one. Matching is on exact targets, so
 * ordinary work (a recursive delete of a build directory, a recursive
 * ownership change in the project) is never caught.
 */

import * as path from "node:path";
import { findPayloads, stripPrefix } from "./command-policy";
import { tokenize } from "./src/workspace-boundary";

const MAX_DEPTH = 6;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh"]);

/** Wrappers whose own options this check does not follow: every word after them counts. */
const OPAQUE_WRAPPERS = new Set([
	"busybox",
	"doas",
	"su",
	"ssh",
	"parallel",
	"watch",
	"setsid",
	"flock",
	"chroot",
	"runuser",
	"unshare",
	"nsenter",
	"script",
]);

/** Shell grammar words that precede a command without being one. */
const GRAMMAR = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);

const SYSTEM_DIRS = [
	"/",
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/boot",
	"/var",
	"/system",
	"/library",
	"/private/etc",
	"/private/var",
];

const DISK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|disk|rdisk|mmcblk)/i;

/** Collapse `//`, `/.`, `/x/..`; drop a trailing slash. Relative paths pass through. */
function normTarget(operand: string): string {
	if (!operand.startsWith("/")) return operand;
	let p = path.posix.normalize(operand);
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	return p;
}

function splitArgs(args: string[]): { flags: string[]; operands: string[] } {
	const flags: string[] = [];
	const operands: string[] = [];
	let afterDashes = false;
	for (const a of args) {
		if (!afterDashes && a === "--") {
			afterDashes = true;
			continue;
		}
		if (!afterDashes && a.length > 1 && a.startsWith("-")) flags.push(a);
		else operands.push(a);
	}
	return { flags, operands };
}

function isRecursive(flags: string[]): boolean {
	return flags.some((f) =>
		f.startsWith("--") ? f === "--recursive" : /^-[A-Za-z]*[rR][A-Za-z]*$/.test(f),
	);
}

function isRootTarget(t: string): boolean {
	return t === "/" || t === "/*";
}

function isSystemTarget(t: string): boolean {
	const lower = t.toLowerCase();
	return SYSTEM_DIRS.some((d) => lower === d || lower === `${d}/*` || lower === `${d}*`) || isRootTarget(t);
}

/** Why this one command is always refused, or null. Exact targets only. */
export function blockedReason(argv: string[]): string | null {
	if (argv.length === 0) return null;
	const name = path.basename(argv[0]).toLowerCase();
	const { flags, operands } = splitArgs(argv.slice(1));
	const targets = operands.map(normTarget);

	if (name === "rm") {
		if (isRecursive(flags) && targets.some(isRootTarget)) return "recursive delete of the root filesystem";
		return null;
	}
	if (name === "chmod") {
		const mode = operands[0];
		if (targets.slice(1).some(isRootTarget) && (isRecursive(flags) || mode === "000")) {
			return "permission change on the root filesystem";
		}
		return null;
	}
	if (name === "chown" || name === "chgrp") {
		if (isRecursive(flags) && targets.slice(1).some(isSystemTarget)) {
			return "recursive ownership change on the root or a system directory";
		}
		return null;
	}
	if (name === "dd") {
		for (const a of argv.slice(1)) {
			if (a.toLowerCase().startsWith("of=") && DISK_DEVICE.test(a.slice(3))) {
				return "overwrite of a disk device";
			}
		}
		return null;
	}
	if (/^mkfs(\.|$)/.test(name) || name === "newfs") {
		if (operands.some((o) => DISK_DEVICE.test(o))) return "format of a disk device";
		return null;
	}
	return null;
}

/** Every suffix of the words: no command can hide behind a wrapper this check cannot read. */
function emitLoose(tokens: string[], out: string[][], depth: number): void {
	for (let i = 0; i < tokens.length; i++) out.push(tokens.slice(i));
	for (const t of tokens) if (/\s/.test(t)) scanLine(t, out, depth + 1);
}

function processSegment(
	rawTokens: string[],
	prevTokens: string[] | null,
	out: string[][],
	depth: number,
): void {
	let tokens = rawTokens;
	while (tokens.length > 0 && GRAMMAR.has(tokens[0])) tokens = tokens.slice(1);
	if (tokens.length === 0) return;
	if (depth > MAX_DEPTH) {
		emitLoose(tokens, out, depth);
		return;
	}
	const unwrapped = stripPrefix(tokens);
	if (!unwrapped) {
		emitLoose(tokens, out, depth);
		return;
	}
	const argv = unwrapped.argv;
	if (argv.length === 0) return;
	out.push(argv);
	const name = path.basename(argv[0]);

	if (OPAQUE_WRAPPERS.has(name)) emitLoose(argv.slice(1), out, depth);
	if (name === "eval") scanLine(argv.slice(1).join(" "), out, depth + 1);
	if (SHELLS.has(name)) {
		for (const t of argv.slice(1)) if (/\s/.test(t)) scanLine(t, out, depth + 1);
		// A shell reading a pipe runs whatever the earlier command printed.
		if (prevTokens && !argv.slice(1).some((a) => /^-[A-Za-z]*c/.test(a))) {
			emitLoose(prevTokens, out, depth);
		}
	}
	for (const payload of findPayloads(argv)) {
		if (payload.length > 0) scanLine(payload.join(" "), out, depth + 1);
	}
}

/** The index just past the `)` that closes a `(` already consumed, honouring nesting. */
function closeParen(text: string, from: number): number {
	let level = 1;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "(") level++;
		else if (text[i] === ")" && --level === 0) return i;
	}
	return text.length;
}

function scanLine(input: string, out: string[][], depth: number): void {
	// A backslash-newline continues the line; a redirect operator is not a separator.
	const text = input
		.replace(/\\\r?\n/g, "")
		.replace(/\d*>&\d+/g, " ")
		.replace(/&>/g, ">");

	const segments: Array<{ tokens: string[]; piped: boolean }> = [];
	let cur = "";
	let piped = false;
	const flush = (nextPiped: boolean) => {
		if (cur.trim()) segments.push({ tokens: tokenize(cur), piped });
		cur = "";
		piped = nextPiped;
	};

	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "\\" && !inSingle) {
			cur += ch + (next ?? "");
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			cur += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			cur += ch;
			continue;
		}
		if (inSingle) {
			cur += ch;
			continue;
		}
		// Substitutions run inside double quotes too.
		if ((ch === "$" || (!inDouble && (ch === "<" || ch === ">"))) && next === "(") {
			const end = closeParen(text, i + 2);
			if (depth < MAX_DEPTH) scanLine(text.slice(i + 2, end), out, depth + 1);
			else emitLoose(tokenize(text.slice(i + 2, end)), out, depth);
			cur += " X ";
			i = end;
			continue;
		}
		if (ch === "`") {
			let end = i + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
			if (depth < MAX_DEPTH) scanLine(text.slice(i + 1, end), out, depth + 1);
			else emitLoose(tokenize(text.slice(i + 1, end)), out, depth);
			cur += " X ";
			i = end;
			continue;
		}
		if (inDouble) {
			cur += ch;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			flush(false);
			i++;
		} else if (ch === "|") {
			if (next === "&") i++;
			flush(true);
		} else if (ch === ";" || ch === "&" || ch === "\n" || ch === "\r" || ch === "(" || ch === ")") {
			flush(false);
		} else {
			cur += ch;
		}
	}
	flush(false);

	for (let s = 0; s < segments.length; s++) {
		const prev = segments[s].piped && s > 0 ? segments[s - 1].tokens : null;
		processSegment(segments[s].tokens, prev, out, depth);
	}
}

/**
 * Every command a line runs, as argv: each segment with its prefixes and
 * wrappers removed, plus the commands inside command substitutions, subshells,
 * groups, loop and condition bodies, quoted shell words, text piped into a
 * shell, and `find -exec` payloads. A wrapper or construct that cannot be
 * read yields every suffix of its words, so nothing hides behind it.
 */
export function commandArgvs(command: string): string[][] {
	const out: string[][] = [];
	scanLine(command, out, 0);
	return out;
}
