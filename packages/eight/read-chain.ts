/**
 * Read-only chaining (#4715). `a; b` and `a && b` are refused by the shell
 * sanitizer, which made `ls dir; wc -l file` cost three calls. When every part
 * is classed read-only by System One's allowlist, the chain is allowed; the
 * caller still runs each part through the sanitizer and the judge.
 */

import { readOnlyAllowlist } from "../decide/allowlist";
import { namesSecret, readAllowPrefixes } from "../permissions/read-allow";
import { sanitizeShellCommand } from "../permissions/shell-sanitizer";

/** Split on an unquoted `;` or `&&`. A `||`, `&` or newline stays in a part and fails its sanitizer. */
export function splitChain(command: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let q: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && q !== "'") {
			cur += ch + (command[i + 1] ?? "");
			i++;
			continue;
		}
		if (q) {
			if (ch === q) q = null;
			cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			q = ch;
			cur += ch;
		} else if (ch === ";") {
			parts.push(cur);
			cur = "";
		} else if (ch === "&" && command[i + 1] === "&") {
			parts.push(cur);
			cur = "";
			i++;
		} else cur += ch;
	}
	parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** The parts of a `;`/`&&` chain whose every part is read-only and sanitizer-safe, else null. */
export function readOnlyChain(command: string): string[] | null {
	const parts = splitChain(command);
	if (parts.length < 2) return null;
	for (const p of parts) {
		if (!sanitizeShellCommand(p).safe) return null;
		if (readOnlyAllowlist(p).verdict !== "pass-without-model") return null;
	}
	return readOnlyAllowlist(command).verdict === "pass-without-model" ? parts : null;
}

/** Folders the person named, as extra readable prefixes for a command, only when it is plainly read-only. */
/** An unquoted glob can reach a secret the prefix check never saw by name. */
function hasUnquotedGlob(command: string): boolean {
	let q: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && q !== "'") {
			i++;
			continue;
		}
		if (q) {
			if (ch === q) q = null;
		} else if (ch === "'" || ch === '"') q = ch;
		else if (ch === "*" || ch === "?" || ch === "[") return true;
	}
	return false;
}

const RECURSIVE_READ =
	/(?:^|[\s;&|])(?:(?:\S*\/)?(?:find|rg|du|tree|ag|ack)|\S+\s+(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive))(?=\s|$)/;

export function readPrefixesFor(command: string): string[] | undefined {
	const prefixes = readAllowPrefixes();
	if (prefixes.length === 0 || namesSecret(command)) return undefined;
	// Globs and recursive reads can reach a sibling secret that was never named (#4715).
	if (
		hasUnquotedGlob(command) ||
		RECURSIVE_READ.test(command) ||
		/\s(-[A-Za-z]*[rR]\b|--recursive)/.test(command)
	)
		return undefined;
	return readOnlyAllowlist(command).verdict === "pass-without-model" ? prefixes : undefined;
}
