/**
 * Structural spellings of a wipe (#4514 family 5): the command name or the target is assembled by the
 * shell from parts the line itself provides. This module reads those parts statically and hands back
 * extra texts to scan, with the parts filled in, in addition to the line as written:
 *
 *  - variables and arrays assigned on the line (`r=rm; $r -rf /`, `a=(rm -rf /); "${a[@]}"`), with
 *    `${x:-d}`, `${x#p}`, `${x%p}`, `${x:o:n}`, `${x/p/r}`, `${x^^}`, `${!x}`, `${#x}` read as the shell reads them;
 *  - `for c in rm; do $c ...`, `read c <<< rm`, `alias r=rm`, and shell functions called on the same line
 *    (positional parameters bound to the call's words);
 *  - command substitutions whose output is plain text (`$(echo rm)`, `` `printf rm` ``).
 *
 * Soundness: a variable assigned several ways takes every value, in any order, so a branch the line may
 * or may not take is covered. A substitution whose output cannot be read becomes SUBST, a non-literal
 * word that `blockedReason` refuses where the command name goes when what follows is a wipe. A value
 * that is not on the line (environment, argv, a file) stays unresolved and is never treated as safe in
 * command position; as an operand it is left to the policy engine's deny-by-default backstop. Too many
 * alternatives to enumerate is itself a refusal (null): nobody types that by hand.
 */
import { stripPrefix } from "./command-policy";
import { tokenize } from "./src/workspace-boundary";

/** What an unreadable command substitution stands for: a non-literal word, never a safe one. */
export const SUBST = "$__SUBST__";

const MAX_UNIT_VARIANTS = 64;
const MAX_VALUES = 32;
const MAX_TOTAL = 2048;
let used = 0;

/** Start a fresh budget for one top-level line (nested scans share it). */
export function resetStructuralBudget(): void {
	used = 0;
}

interface Binding {
	vals: Set<string>;
	joined: Set<string>;
}
type Env = Map<string, Binding>;

/** True when the text could hold a structural spelling at all; everything else skips this module. */
const TRIGGER = /[$`]|\balias\b|\(\s*\)\s*\{|\bfunction\b/;

/**
 * The line as written, then extra texts (one per statement variant) with the line's own variables,
 * aliases, functions and readable substitutions filled in. Null: too many alternatives to enumerate.
 */
export function structuralForms(text: string): string[] | null {
	if (!TRIGGER.test(text)) return [text];
	// Twice: once reading quotes as the shell does, once with quotes guessed away, so a quote the
	// first reading misjudges (a `'` inside `"${x#'"'}"`) cannot hide a statement from the second.
	const out: string[] = [text];
	for (const blind of [false, true]) {
		blindMode = blind;
		try {
			const forms = formsOf(text);
			if (forms === null) return null;
			for (const f of forms) if (!out.includes(f)) out.push(f);
		} finally {
			blindMode = false;
		}
	}
	return out;
}

/** Quote handling is switched off: every quote character is an ordinary letter (see structuralForms). */
let blindMode = false;

function formsOf(text: string): string[] | null {
	const env: Env = new Map();
	const funcs = new Map<string, string>();
	if (!collect(text, env, funcs)) return null;
	const out: string[] = [];
	for (const unit of splitUnits(text)) {
		const vs = unitVariants(unit, env, funcs, 0);
		if (vs === null) return null;
		for (const v of vs) if (v !== unit && !out.includes(v)) out.push(v);
		used += vs.length;
		if (used > MAX_TOTAL) return null;
	}
	return out;
}

// ── text walking ──────────────────────────────────────────────────────────

/** Which characters sit inside `'...'`: the shell expands nothing there. A `'` inside `"..."` is literal. */
function singleQuoted(text: string): boolean[] {
	const sq: boolean[] = new Array(text.length).fill(false);
	if (blindMode) return sq;
	let inS = false;
	let inD = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inS) {
			sq[i] = true;
			if (c === "'") inS = false;
		} else if (c === "\\") {
			i++;
		} else if (c === "'" && !inD) {
			inS = true;
			sq[i] = true;
		} else if (c === '"') inD = !inD;
	}
	return sq;
}

/** Statements: split on `;` `&` `|` and newlines outside quotes, parentheses and backticks. */
function splitUnits(text: string): string[] {
	if (blindMode) return text.split(/[;&|\n]/).filter((u) => u.trim() !== "");
	const sq = singleQuoted(text);
	const units: string[] = [];
	let start = 0;
	let depth = 0;
	let inD = false;
	let inB = false;
	for (let i = 0; i < text.length; i++) {
		if (sq[i]) continue;
		const c = text[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === '"') inD = !inD;
		else if (c === "`") inB = !inB;
		else if (!inD && !inB && c === "(") depth++;
		else if (!inD && !inB && c === ")" && depth > 0) depth--;
		else if (!inD && !inB && depth === 0 && (c === ";" || c === "\n" || c === "&" || c === "|")) {
			units.push(text.slice(start, i));
			start = i + 1;
		}
	}
	units.push(text.slice(start));
	return units.filter((u) => u.trim() !== "");
}

/** The index of the bracket that closes the one opened just before `from`, honouring nesting; -1 if none. */
function matching(text: string, from: number, open: string, close: string): number {
	let level = 1;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === open) level++;
		else if (text[i] === close && --level === 0) return i;
	}
	return -1;
}

/** One shell word starting at i (quotes, `$(...)` and `${...}` kept whole): its end index. */
function readWord(text: string, i: number): number {
	let q = "";
	let j = i;
	for (; j < text.length; j++) {
		const c = text[j];
		if (c === "\\") {
			j++;
			continue;
		}
		if (q) {
			if (c === q) q = "";
			continue;
		}
		if (c === "'" || c === '"') q = c;
		else if (c === "$" && (text[j + 1] === "(" || text[j + 1] === "{")) {
			const e = matching(text, j + 2, text[j + 1], text[j + 1] === "(" ? ")" : "}");
			if (e < 0) return text.length;
			j = e;
		} else if (c === "`") {
			const e = text.indexOf("`", j + 1);
			if (e < 0) return text.length;
			j = e;
		} else if (/[\s;&|<>()]/.test(c)) break;
	}
	return j;
}

/** Remove one level of quoting and backslashes from a word. */
function unquote(raw: string): string {
	let out = "";
	let q = "";
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (c === "\\" && q !== "'") {
			if (i + 1 < raw.length) out += raw[++i];
		} else if (q) {
			if (c === q) q = "";
			else out += c;
		} else if (c === "'" || c === '"') q = c;
		else out += c;
	}
	return out;
}

// ── collecting what the line assigns ──────────────────────────────────────

function bind(env: Env, name: string): Binding {
	let b = env.get(name);
	if (!b) env.set(name, (b = { vals: new Set(), joined: new Set() }));
	return b;
}

/** Add a value; false when the variable has more values than are worth enumerating. */
function addVal(b: Binding, v: string): boolean {
	b.vals.add(v);
	return b.vals.size <= MAX_VALUES;
}

const ASSIGN = /(?<=^|[\s;&|({])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]\n]*\])?(\+?)=/g;
const FOR_IN = /\b(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]*)/g;
const READ_HERE = /\bread\s+(?:-[A-Za-z]+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*<<<\s*/g;
const ALIAS = /\balias\s+([A-Za-z_][A-Za-z0-9_.-]*)=/g;
const FUNC =
	/(?<=^|[\s;&|({])(?:function\s+([A-Za-z_][\w.-]*)(?:\s*\(\s*\))?|([A-Za-z_][\w.-]*)\s*\(\s*\))\s*\{/g;

/** Read every assignment, loop variable, alias and function on the line. False: too many values. */
function collect(text: string, env: Env, funcs: Map<string, string>): boolean {
	for (const m of text.matchAll(ALIAS)) {
		const at = (m.index as number) + m[0].length;
		funcs.set(`alias:${m[1]}`, unquote(text.slice(at, readWord(text, at))));
	}
	for (const m of text.matchAll(FUNC)) {
		const open = (m.index as number) + m[0].length;
		const close = matching(text, open, "{", "}");
		funcs.set(m[1] ?? m[2], text.slice(open, close < 0 ? text.length : close));
	}
	// Twice: a value may name a variable assigned later on the line (inside a loop body).
	for (let pass = 0; pass < 2; pass++) {
		for (const m of text.matchAll(ASSIGN)) {
			const at = (m.index as number) + m[0].length;
			const b = bind(env, m[1]);
			if (text[at] === "(") {
				if (!collectArray(text, at, env, b)) return false;
				continue;
			}
			const alts = expandUses(text.slice(at, readWord(text, at)), env, true);
			if (alts === null) return false;
			const before = [...b.vals];
			for (const a of alts) {
				const v = unquote(a);
				if (!addVal(b, v)) return false;
				if (m[2] === "+") for (const o of before) if (!addVal(b, o + v)) return false;
			}
		}
		for (const m of text.matchAll(FOR_IN)) {
			const b = bind(env, m[1]);
			for (const w of m[2]
				.replace(/\bdo\b.*$/, "")
				.split(/\s+/)
				.filter(Boolean)) {
				const alts = expandUses(w, env, true);
				if (alts === null) return false;
				for (const a of alts) if (!addVal(b, unquote(a))) return false;
			}
		}
		for (const m of text.matchAll(READ_HERE)) {
			const at = (m.index as number) + m[0].length;
			const alts = expandUses(text.slice(at, readWord(text, at)), env, true);
			if (alts === null) return false;
			const b = bind(env, m[1]);
			for (const a of alts) if (!addVal(b, unquote(a))) return false;
		}
	}
	return true;
}

/** `name=( w1 w2 ... )`: each element is a value, and the whole list is one more (`"${a[@]}"`). */
function collectArray(text: string, at: number, env: Env, b: Binding): boolean {
	const close = matching(text, at + 1, "(", ")");
	const inner = text.slice(at + 1, close < 0 ? text.length : close);
	let lists: string[][] = [[]];
	for (let i = 0; i < inner.length; ) {
		if (/\s/.test(inner[i])) {
			i++;
			continue;
		}
		const e = Math.max(readWord(inner, i), i + 1);
		const alts = expandUses(inner.slice(i, e), env, true);
		if (alts === null) return false;
		lists = lists.flatMap((l) => alts.map((a) => [...l, unquote(a)]));
		if (lists.length > MAX_VALUES) return false;
		i = e;
	}
	for (const l of lists) {
		b.joined.add(l.join(" "));
		for (const v of l) if (!addVal(b, v)) return false;
	}
	return true;
}

// ── filling the uses in ───────────────────────────────────────────────────

const ESC_RE = /[.*+?^${}()|[\]\\]/g;

/** A shell glob as an anchored RegExp (`*`, `?`, bracket classes); null when it will not compile. */
function globRe(pattern: string): RegExp | null {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[" && pattern.indexOf("]", i + 2) > 0) {
			const e = pattern.indexOf("]", i + 2);
			re += `[${pattern
				.slice(i + 1, e)
				.replace(/^!/, "^")
				.replace(/\\/g, "\\\\")}]`;
			i = e;
		} else if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(ESC_RE, "\\$&");
		else re += c.replace(ESC_RE, "\\$&");
	}
	try {
		return new RegExp(`^${re}$`, "s");
	} catch {
		return null;
	}
}

/** Every substring of a short value: what `${x:$n:$m}` can be when the offsets are not plain numbers. */
function substrings(v: string): string[] {
	if (v.length > 48) return [v];
	const out = new Set<string>();
	for (let a = 0; a <= v.length; a++) for (let b = a; b <= v.length; b++) out.add(v.slice(a, b));
	return [...out];
}

/** What `${body}` can be, or null when the form is not one read here (the text then stays as written). */
function braceAlts(body: string, env: Env): string[] | null {
	const m = /^([!#]?)([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?([\s\S]*)$/.exec(body);
	if (!m) return null;
	const [, lead, name, index, rest] = m;
	const b = env.get(name);
	const vals = (x: Binding | undefined): string[] =>
		x
			? [
					...new Set([
						...x.vals,
						...(index === "@" || index === "*" || index === undefined ? x.joined : []),
					]),
				]
			: [];
	if (lead === "#") return rest === "" && b ? vals(b).map((v) => String(v.length)) : null;
	if (lead === "!") {
		if (rest !== "" || !b) return null;
		return [...new Set(vals(b).flatMap((v) => vals(env.get(v))))];
	}
	if (rest === "") return b ? vals(b) : null;
	const op = /^(:?[-=+?]|##?|%%?|:|\/\/|\/[#%]?|\^\^?|,,?)([\s\S]*)$/.exec(rest);
	if (!op) return null;
	const [, o, arg] = op;
	const word = (): string[] => (expandUses(arg, env, false) ?? [arg]).map(unquote);
	if (o === ":-" || o === "-" || o === ":=" || o === "=") return [...vals(b), ...word()];
	if (o === ":+" || o === "+") return ["", ...word()];
	if (!b) return null;
	if (o === ":?" || o === "?") return vals(b);
	if (o === "^" || o === "^^" || o === "," || o === ",,")
		return vals(b).flatMap((v) => [v, o[0] === "^" ? v.toUpperCase() : v.toLowerCase()]);
	if (o === "#" || o === "##" || o === "%" || o === "%%") {
		const re = globRe(word()[0] ?? "");
		return vals(b).map((v) => {
			if (!re) return v;
			const cuts = [...Array(v.length + 1).keys()];
			if (o[0] === "#") {
				const hit = cuts.filter((k) => re.test(v.slice(0, k)));
				const k = o === "#" ? hit[0] : hit[hit.length - 1];
				return k === undefined ? v : v.slice(k);
			}
			const hit = cuts.filter((k) => re.test(v.slice(k)));
			const k = o === "%" ? hit[hit.length - 1] : hit[0];
			return k === undefined ? v : v.slice(0, k);
		});
	}
	if (o === ":") {
		const n = /^\s*(-?\d+)\s*(?::\s*(-?\d+)\s*)?$/.exec(arg);
		if (!n) return vals(b).flatMap(substrings);
		return vals(b).map((v) => {
			const off = Number(n[1]) < 0 ? Math.max(0, v.length + Number(n[1])) : Number(n[1]);
			if (n[2] === undefined) return v.slice(off);
			return Number(n[2]) < 0
				? v.slice(off, v.length + Number(n[2]))
				: v.slice(off, off + Number(n[2]));
		});
	}
	// `${x/pat/rep}`, `${x//pat/rep}`, `${x/#pat/rep}`, `${x/%pat/rep}`: every way the pattern can match.
	const cut = arg.search(/(?<!\\)\//);
	const re = globRe(unquote(cut < 0 ? arg : arg.slice(0, cut)));
	const rep = cut < 0 ? "" : unquote(arg.slice(cut + 1));
	if (!re) return null;
	return vals(b).flatMap((v) => {
		const out = new Set<string>([v]);
		for (let a = 0; a <= v.length; a++)
			for (let z = a + 1; z <= v.length; z++) {
				if ((o === "/#" && a !== 0) || (o === "/%" && z !== v.length)) continue;
				if (re.test(v.slice(a, z))) out.add(v.slice(0, a) + rep + v.slice(z));
			}
		return [...out];
	});
}

/**
 * Every spelling of `raw` with the variable uses it holds filled in. A use of a variable the line never
 * assigns, or in a form not read here, stays as written. `esc` backslash-quotes inserted values for a
 * caller that will unquote the result. Null: more alternatives than MAX_UNIT_VARIANTS.
 */
function expandUses(raw: string, env: Env, esc: boolean): string[] | null {
	if (!raw.includes("$")) return [raw];
	const sq = singleQuoted(raw);
	let acc = [""];
	let lit = "";
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (c === "\\" && !sq[i]) {
			lit += c + (raw[i + 1] ?? "");
			i++;
			continue;
		}
		let alts: string[] | null = null;
		let end = i;
		if (c === "$" && !sq[i]) {
			if (raw[i + 1] === "{") {
				const e = matching(raw, i + 2, "{", "}");
				if (e > 0) {
					alts = braceAlts(raw.slice(i + 2, e), env);
					end = e;
				}
			} else {
				const n = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i + 1));
				const b = n ? env.get(n[0]) : undefined;
				if (n && b) {
					alts = [...new Set([...b.vals, ...b.joined])];
					end = i + n[0].length;
				}
			}
		}
		if (alts === null) {
			lit += c;
			continue;
		}
		const head = lit;
		lit = "";
		const ins = esc ? alts.map((a) => a.replace(/[\\'"]/g, "\\$&")) : alts;
		acc = [...new Set(acc.flatMap((a) => ins.map((v) => a + head + v)))];
		if (acc.length > MAX_UNIT_VARIANTS) return null;
		i = end;
	}
	return acc.map((a) => a + lit);
}

// ── command substitution, aliases and functions ───────────────────────────

/** The text a command substitution body prints, when that is plain: `echo a b`, `printf 'rm -rf /'`. */
function literalOutput(body: string): string | null {
	const words = tokenize(body.trim(), ""); // backslashes stay: `printf '\x72m'` needs them
	if (words.length === 0 || /[|;&<>$`()]/.test(body.replace(/'[^']*'|"[^"]*"/g, ""))) return null;
	if (words.some((w) => /[$`]/.test(w))) return null;
	const escapes = (s: string) =>
		s.replace(/\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|([nt\\]))/g, (_m, h, o, c) => {
			if (h) return String.fromCharCode(Number.parseInt(h, 16));
			if (o) return String.fromCharCode(Number.parseInt(o, 8) & 255);
			return c === "n" ? "\n" : c === "t" ? "\t" : "\\";
		});
	let text: string;
	if (words[0] === "echo") {
		let i = 1;
		let interpret = false;
		while (/^-[neE]+$/.test(words[i] ?? "")) interpret ||= words[i++].includes("e");
		text = words.slice(i).join(" ");
		if (interpret) text = escapes(text);
	} else if (words[0] === "printf") {
		const fmt = words[1];
		if (fmt === undefined || /%[^s%]/.test(fmt)) return null;
		const args = words.slice(2);
		let k = 0;
		text = escapes(fmt).replace(/%[s%]/g, (s) => (s === "%%" ? "%" : (args[k++] ?? "")));
	} else return null;
	return text.replace(/\n+$/, "");
}

/**
 * The text with each command substitution outside single quotes replaced: a readable one by its
 * output, any other by SUBST. Null when nothing was replaced.
 */
function resolveSubstitutions(text: string): string | null {
	const sq = singleQuoted(text);
	let out = "";
	let changed = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		let end = -1;
		let body = "";
		if (c === "\\" && !sq[i]) {
			out += c + (text[i + 1] ?? "");
			i++;
			continue;
		}
		if (!sq[i] && c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
			end = matching(text, i + 2, "(", ")");
			body = text.slice(i + 2, end < 0 ? text.length : end);
		} else if (!sq[i] && c === "`") {
			end = text.indexOf("`", i + 1);
			body = text.slice(i + 1, end < 0 ? text.length : end);
		}
		if (end < 0) {
			out += c;
			continue;
		}
		out += literalOutput(body) ?? SUBST;
		changed = true;
		i = end;
	}
	return changed ? out : null;
}

/** Positional parameters in a function body, replaced by the call's words. */
function bindArgs(body: string, args: string[]): string {
	return body.replace(/\$(?:\{([0-9]+|[@*])\}|([0-9]|[@*]))/g, (_m, a, b) => {
		const k = a ?? b;
		return k === "@" || k === "*" ? args.join(" ") : (args[Number(k) - 1] ?? "");
	});
}

/**
 * Every spelling of one statement with the line's aliases, functions, variables and readable
 * substitutions applied, the statement itself included. Null: too many alternatives.
 */
function unitVariants(
	unit: string,
	env: Env,
	funcs: Map<string, string>,
	depth: number,
): string[] | null {
	const forms = [unit];
	const lead = /^[\s{!(]*([A-Za-z_][\w.-]*)(?=\s|$)/.exec(unit);
	if (lead && depth < 3) {
		const rest = unit.slice(lead[0].length);
		const alias = funcs.get(`alias:${lead[1]}`);
		if (alias !== undefined) forms.push(`${alias}${rest}`);
		const fn = funcs.get(lead[1]);
		if (fn !== undefined) {
			for (const u of splitUnits(bindArgs(fn, tokenize(rest)))) {
				const sub = unitVariants(u, env, funcs, depth + 1);
				if (sub === null) return null;
				forms.push(...sub);
			}
		}
	}
	const out = new Set<string>();
	for (const f of forms) {
		const alts = expandUses(f, env, false);
		if (alts === null) return null;
		for (const a of alts) {
			out.add(a);
			const r = resolveSubstitutions(a);
			if (r !== null) out.add(r);
		}
	}
	return out.size > MAX_UNIT_VARIANTS ? null : [...out];
}

// ── a recursive delete whose operand the line does not resolve ─────────────

/** `$x`, `${x}`, `${x:?}`, `${x:-d}` standing alone as an operand, with at most a trailing `/` or `/*`. */
const WHOLE_VAR =
	/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:[:]?[-=?+][^}]*)?\})\/?\*?$/;
const RECURSIVE_FLAG = /^(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)$/;
/** A value the line itself fixes: plain text, or the directory `mktemp` just made. */
const LITERAL_OR_MKTEMP = /^(?:[^$`]*|\$\(\s*mktemp(?:\s[^)]*)?\)|`\s*mktemp(?:\s[^`]*)?`)$/;

/**
 * A reason a person must approve, when a recursive `rm` on this line takes an operand that is wholly a
 * value the line does not resolve: a variable never assigned here (or assigned from anything but plain
 * text or `mktemp`), or an unreadable command substitution (#4514 family 5). `d=$(mktemp -d); rm -rf "$d"`
 * and `d=build; rm -rf $d` are resolved on the line and pass; `rm -rf $DIR` and `rm -rf $(cat list)` ask.
 * Quoted inner scripts (`sh -c`, `eval`) are read the same way. Null when nothing qualifies.
 */
export function unresolvedDeleteReason(text: string, depth = 0): string | null {
	if (!TRIGGER.test(text) || depth > 3) return null;
	const env: Env = new Map();
	if (!collect(text, env, new Map())) return null;
	const resolved = (name: string): boolean => {
		const b = env.get(name);
		return (
			b !== undefined && b.vals.size > 0 && [...b.vals].every((v) => LITERAL_OR_MKTEMP.test(v))
		);
	};
	for (const unit of splitUnits(text)) {
		const tokens = tokenize(resolveSubstitutions(unit) ?? unit);
		const argv = stripPrefix(tokens)?.argv ?? tokens;
		for (const t of tokens)
			if (/\s/.test(t) && !t.startsWith("-")) {
				const inner = unresolvedDeleteReason(t, depth + 1);
				if (inner) return inner;
			}
		if (argv.length === 0 || argv[0].split("/").pop() !== "rm") continue;
		const dashes = argv.indexOf("--");
		const flags = argv.slice(1, dashes < 0 ? undefined : dashes).filter((a) => a.startsWith("-"));
		if (!flags.some((f) => RECURSIVE_FLAG.test(f))) continue;
		const operands = argv
			.slice(1)
			.filter((a, i) => (dashes >= 0 ? i + 1 > dashes : !a.startsWith("-")));
		for (const o of operands) {
			const m = WHOLE_VAR.exec(o);
			if ((m && !resolved(m[1] ?? m[2])) || o === SUBST || o === `${SUBST}/`) {
				return "a recursive delete of a value the command line does not show: a person must approve it";
			}
		}
	}
	return null;
}
