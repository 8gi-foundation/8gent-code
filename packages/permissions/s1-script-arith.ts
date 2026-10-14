/**
 * Arithmetic in a script body: where bash reads a variable's VALUE as an expression.
 *
 * bash evaluates an array subscript inside an arithmetic expression, and evaluating
 * `a[$(cmd)]` runs cmd. So a value that came from data (a file read with `$(cat f)` or `read`,
 * a glob match, an argument, the environment, a quoted literal) runs commands the body never
 * shows once it reaches arithmetic: `$((x))`, `$[x]`, `((x))`, `for ((...))`, `let`,
 * `[[ x -eq 0 ]]`, a subscript `${a[x]}` or `a[x]=`, a substring offset `${s:x}`,
 * `declare -i`, `${!x}`, and OPTIND (read by getopts). Measured on /bin/bash 3.2, 14 Oct 2026;
 * builtin number arguments (`shift "$x"`, `exit "$x"`, `printf %d "$x"`) were measured and do
 * not evaluate.
 *
 * A name may appear in arithmetic only when its value is always an integer the body itself
 * set: its first mention is an unconditional top-level line `NAME=<integer>` or
 * `NAME=$((...))`, and the scan saw no other kind of write to it. Anything else in arithmetic
 * (another name, a script argument, a command substitution, a quote or escape) is not read.
 * `waited=0` then `waited=$((waited + 1))` stays checked.
 *
 * Unquoted heredoc bodies expand, so they are read the same way (without quote masking: a
 * quote is literal there). Heredocs fed to a shell are bodies of their own (bodyNotRead).
 */

import { cutHeredocs, splitSegments } from "../decide/rules";

/** A name that is not a variable: an operator word in `[[ ]]`. */
const ARITH_TEST = /^-(?:eq|ne|lt|le|gt|ge)$/;
const OPENERS = new Set(["if", "while", "until", "for", "select", "case", "{"]);
const CLOSERS = new Set(["fi", "done", "esac", "}"]);
const LEADS = new Set(["then", "do", "else", "elif", "!", "time"]);

/** Blank what does not expand: single quotes, `$'...'`, escaped characters and comments. */
function mask(text: string, quotes: boolean): string {
	let out = "";
	let dq = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			out += "  ";
			i++;
			continue;
		}
		if (quotes && !dq && c === "'") {
			const ansi = out.endsWith("$");
			let j = i + 1;
			while (j < text.length && text[j] !== "'") j += ansi && text[j] === "\\" ? 2 : 1;
			out += " ".repeat(Math.min(j, text.length - 1) - i + 1);
			i = j;
			continue;
		}
		if (quotes && c === '"') dq = !dq;
		if (quotes && !dq && c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
			const j = text.indexOf("\n", i);
			const end = j < 0 ? text.length : j;
			out += " ".repeat(end - i);
			i = end - 1;
			continue;
		}
		out += c;
	}
	return out;
}

/** Index just past the bracket matching the opener at `i` (`(` or `[` or `{`), or -1. */
function close(s: string, i: number): number {
	const open = s[i];
	const shut = open === "(" ? ")" : open === "[" ? "]" : "}";
	let d = 0;
	for (let k = i; k < s.length; k++) {
		if (s[k] === open) d++;
		else if (s[k] === shut && --d === 0) return k + 1;
	}
	return -1;
}

/** Every piece of `m` (masked text) that bash reads as arithmetic, or a reason it is not read. */
function regions(m: string): { parts: string[]; why: string | null } {
	const parts: string[] = [];
	const no = (why: string) => ({ parts, why });
	for (let i = 0; i < m.length; i++) {
		const two = m.slice(i, i + 2);
		if (two === "((" || (two === "$[" && m[i - 1] !== "\\")) {
			const at = two === "((" ? i : i + 1;
			const end = close(m, at);
			if (end < 0) return no("the script has arithmetic this check cannot close");
			parts.push(m.slice(at + 1, end - 1));
			continue;
		}
		if (two === "${") {
			if (m[i + 2] === "!")
				return no("the script uses ${!...}, which names a variable when it runs");
			const end = close(m, i + 1);
			if (end < 0) return no("the script has an unclosed ${");
			const inner = m.slice(i + 2, end - 1);
			if (/@P$/.test(inner)) return no("the script uses ${...@P}, which runs text as a prompt");
			const nm = /^#?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/.exec(inner);
			let rest = nm ? inner.slice(nm[0].length) : "";
			if (rest.startsWith("[")) {
				const e = close(rest, 0);
				if (e < 0) return no("the script has an unclosed subscript");
				const sub = rest.slice(1, e - 1);
				if (sub !== "@" && sub !== "*") parts.push(sub);
				rest = rest.slice(e);
			}
			// `${s:off}` and `${s:off:len}` (not `:-` `:=` `:+` `:?`) are arithmetic.
			if (/^:(?![-=+?])/.test(rest)) parts.push(...rest.slice(1).split(":"));
			continue;
		}
	}
	// A subscript assigned to: `a[x]=`, `a[x]+=`, `arr=([x]=v)`, `declare a[x]=v`.
	for (const s of m.matchAll(/\[([^\]\n]*)\]\+?=/g)) parts.push(s[1]);
	const { segs } = splitSegments(m);
	for (const { text } of segs) {
		const ws = text.trim().split(/\s+/);
		let k = 0;
		while (LEADS.has(ws[k])) k++;
		if (ws[k] === "let") parts.push(ws.slice(k + 1).join(" "));
		// `[[ a -eq b ]]` reads both sides of each arithmetic test as arithmetic.
		for (let j = 0; j < ws.length; j++)
			if (ARITH_TEST.test(ws[j]) && ws.slice(0, j).includes("[["))
				parts.push(ws[j - 1] ?? "", ws[j + 1] ?? "");
	}
	return { parts, why: null };
}

/** Names `part` reads, or why it is not read. */
function namesIn(part: string): { names: string[]; why: string | null } {
	const no = (why: string) => ({ names: [], why });
	if (/[`'\\]|\$\((?!\()/.test(part))
		return no("the script has a command substitution or quote in arithmetic");
	let p = part.replace(/"/g, " ");
	p = p.replace(/\$\{#[A-Za-z_][A-Za-z0-9_]*(?:\[[@*]\])?\}|\$\{#\}|\$[#?$!]/g, " 0 ");
	if (/\$\{?[0-9@*]/.test(p)) return no("the script reads a script argument in arithmetic");
	p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, " $1 ").replace(/\$(?=[A-Za-z_])/g, " ");
	if (/[${}]/.test(p))
		return no("the script has an expansion in arithmetic this check does not read");
	return {
		names: [...p.matchAll(/(?<![A-Za-z0-9_#])[A-Za-z_][A-Za-z0-9_]*/g)].map((x) => x[0]),
		why: null,
	};
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when `name` always holds an integer the body set: its first mention (comment lines
 * aside) is a whole line `name=<int>` or `name=$((...))`, not inside a heredoc, after no
 * unclosed if/while/for/case/brace, no subshell, and not continued from a previous line.
 */
function setFirstAsInteger(body: string, name: string): boolean {
	const word = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, "g");
	let at = -1;
	for (const m of body.matchAll(word)) {
		const ls = body.lastIndexOf("\n", m.index as number) + 1;
		if (/^\s*#/.test(body.slice(ls, m.index))) continue;
		at = m.index as number;
		break;
	}
	if (at < 0) return false;
	const ls = body.lastIndexOf("\n", at) + 1;
	const le = body.indexOf("\n", at) < 0 ? body.length : body.indexOf("\n", at);
	const line = body.slice(ls, le);
	const assign = new RegExp(
		`^[ \\t]*${escapeRe(name)}=(?:-?[0-9]+|"?\\$\\(\\(.*?\\)\\)"?)[ \\t]*(?:;[^&|]*|#.*)?$`,
	);
	if (!assign.test(line) || body.slice(ls, at).trim() !== "") return false;
	const prefix = body.slice(0, ls);
	if (/(?:&&|\|\||\||\\|!)\s*$/.test(prefix)) return false;
	// The line must be real text, not part of a heredoc body.
	const cut = cutHeredocs(body.slice(0, le)).text;
	if (!cut.endsWith(line)) return false;
	let depth = 0;
	for (const { text } of splitSegments(cutHeredocs(prefix).text).segs) {
		const ws = text.trim().split(/\s+/);
		let k = 0;
		while (LEADS.has(ws[k])) k++;
		const w = ws[k] ?? "";
		if (w.startsWith("(") && !w.startsWith("((")) return false;
		if (OPENERS.has(w)) depth++;
		else if (CLOSERS.has(w) || CLOSERS.has(w.replace(/[;)]+$/, ""))) depth--;
		if (depth < 0) return false;
	}
	return depth === 0;
}

/**
 * Why arithmetic in `body` may read a value this check did not set, or null. `written`: names
 * the scan saw written with a value that may not be an integer (read, for, `x=$(...)`, ...).
 * `docs`: unquoted heredoc bodies not fed to a shell (they expand, quotes literal).
 */
export function arithNotRead(body: string, written: Set<string>, docs: string[]): string | null {
	if (written.has("OPTIND")) return "the script sets OPTIND, which getopts reads as arithmetic";
	const found = [
		regions(mask(cutHeredocs(body).text, true)),
		...docs.map((d) => regions(mask(d, false))),
	];
	const safe = new Map<string, boolean>();
	for (const { parts, why } of found) {
		if (why) return why;
		for (const part of parts) {
			const r = namesIn(part);
			if (r.why) return r.why;
			for (const n of r.names) {
				if (!safe.has(n)) safe.set(n, !written.has(n) && setFirstAsInteger(body, n));
				if (!safe.get(n))
					return `the script reads ${n} in arithmetic, where a value it did not set can run a command`;
			}
		}
	}
	return null;
}
