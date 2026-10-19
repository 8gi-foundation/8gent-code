/**
 * 8gent Code - Workspace Boundary Enforcement
 *
 * Hardens the permission engine against path traversal attacks. All file paths
 * referenced by file-system tools and shell commands are resolved through
 * `realpathSync` (collapsing symlinks and `..` segments) and rejected if the
 * resolved location falls outside the user's workspace root.
 *
 * Inspired by holaOS Section 1 (`docs/specs/HOLAOS-EXTRACTIONS.md`) — rebuilt
 * from scratch to fit the existing NemoClaw policy engine. Issue #2083.
 */

import * as fs from "node:fs";
import { type HomeEnv, resolveHome } from "../../core/home";
import { isPathWithin, pathFor } from "../../core/path-within";
import { fromLongPath } from "../../core/win-path";

// ============================================
// Types
// ============================================

export interface BoundaryViolation {
	/** The literal token / path the agent tried to use */
	raw: string;
	/** The resolved absolute path (post realpath / normalize) */
	resolved: string;
	/** Human-readable reason for rejection */
	reason: string;
}

export interface BoundaryCheckResult {
	allowed: boolean;
	violations: BoundaryViolation[];
}

/**
 * The machine a command will run on. Paths are parsed with its separator and
 * case rules, and `~`, `$VAR` and `%VAR%` expand from its environment.
 * Defaults to the current process; tests inject a foreign platform, and the
 * real filesystem is consulted only when the platform is the host's own.
 */
export interface BoundaryHost {
	platform: NodeJS.Platform;
	env: HomeEnv;
}

function hostOf(host: Partial<BoundaryHost> = {}): BoundaryHost {
	return { platform: host.platform ?? process.platform, env: host.env ?? process.env };
}

/**
 * Options for command extraction. Allowlists let callers permit known safe
 * absolute prefixes outside the workspace (e.g. system binaries on PATH).
 */
export interface ExtractOptions {
	workspaceRoot: string;
	/** Absolute path prefixes that are always allowed (e.g. /usr/bin) */
	allowedAbsolutePrefixes?: string[];
	host?: Partial<BoundaryHost>;
}

// ============================================
// Path resolution
// ============================================

/**
 * Resolve a path through `realpathSync` if it exists; otherwise fall back to
 * `resolve` so we still collapse `..` segments for not-yet-created files.
 *
 * For non-existent paths we walk up to the deepest existing ancestor and
 * realpath that, then re-append the remainder. This catches the common
 * "/workspace/symlink-to-etc/passwd" pattern even when `passwd` itself does
 * not exist under the symlinked target.
 */
export function resolveSafe(
	p: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const flavor = pathFor(platform);
	const absolute = flavor.resolve(fromLongPath(cwd, platform), fromLongPath(p, platform));
	if (platform !== process.platform) return absolute;

	const tail: string[] = [];
	let cursor = absolute;
	for (;;) {
		try {
			return fromLongPath(flavor.resolve(fs.realpathSync(cursor), ...tail), platform);
		} catch {
			const parent = flavor.dirname(cursor);
			if (parent === cursor) return absolute;
			tail.unshift(flavor.basename(cursor));
			cursor = parent;
		}
	}
}

/**
 * `true` iff `resolvedPath` is `workspaceRoot` itself or lives strictly
 * beneath it. Both sides are realpath'd so symlink wrappers around the
 * workspace (macOS `/var` -> `/private/var`) don't read as escapes.
 */
export function isWithinWorkspace(
	resolvedPath: string,
	workspaceRoot: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return isPathWithin(
		resolveSafe(resolvedPath, workspaceRoot, platform),
		resolveSafe(workspaceRoot, workspaceRoot, platform),
		platform,
	);
}

/**
 * Convenience: resolve a single path and check confinement in one shot.
 */
export function checkPath(
	rawPath: string,
	workspaceRoot: string,
	options: { allowedAbsolutePrefixes?: string[]; host?: Partial<BoundaryHost> } = {},
): BoundaryCheckResult {
	const { platform } = hostOf(options.host);
	const resolved = resolveSafe(rawPath, workspaceRoot, platform);

	if (isConfined(resolved, workspaceRoot, options.allowedAbsolutePrefixes, platform)) {
		return { allowed: true, violations: [] };
	}

	return {
		allowed: false,
		violations: [
			{
				raw: rawPath,
				resolved,
				reason: `Path escapes workspace root (${workspaceRoot})`,
			},
		],
	};
}

function isConfined(
	resolved: string,
	workspaceRoot: string,
	prefixes: string[] | undefined,
	platform: NodeJS.Platform,
): boolean {
	const flavor = pathFor(platform);
	for (const prefix of prefixes ?? []) {
		// Prefixes are NOT realpath'd: a prefix that is itself a symlink must not pull
		// its target into the allow-list.
		if (isPathWithin(resolved, flavor.resolve(prefix), platform)) return true;
	}
	return isWithinWorkspace(resolved, workspaceRoot, platform);
}

// ============================================
// Quote-aware command tokenizer
// ============================================

/**
 * A single segment of a shell pipeline split on `&&`, `||`, `;`, or `|`.
 * Each segment carries its own argv plus the `cd` target if any (so we can
 * re-anchor relative paths in the next segment, mirroring shell semantics).
 */
export interface CommandSegment {
	argv: string[];
	/** If this segment is a `cd <target>`, the resolved cwd that follows */
	cdTarget?: string;
}

/**
 * Tokenize a single shell segment into argv. Handles:
 *   - single quotes (literal, no escape recognition)
 *   - double quotes (allows backslash escape of " and \)
 *   - backslash-escaped spaces and metacharacters outside quotes
 *   - tabs/whitespace as separators
 *
 * `escapes` names the characters that escape the next one: `\` for POSIX
 * shells, `^` and a backtick for cmd.exe and PowerShell, where `\` is a path
 * separator.
 *
 * Does NOT do variable expansion or command substitution — those are
 * deliberately left raw so we can detect them as suspicious downstream.
 */
export function tokenize(input: string, escapes = "\\"): string[] {
	return words(input, escapes, false);
}

/**
 * Split on unquoted whitespace. With `raw` the words keep their quotes and
 * escape characters, so a caller can tell `D=x` (an assignment) from `"D=x"`
 * (a command named `D=x`); word boundaries are identical either way.
 */
function words(input: string, escapes: string, raw: boolean): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let inSingle = false;
	let inDouble = false;
	let escape = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (escape) {
			current += ch;
			started = true;
			escape = false;
			continue;
		}

		if (escapes.includes(ch) && !inSingle) {
			if (raw) current += ch;
			escape = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			if (raw) current += ch;
			inSingle = !inSingle;
			started = true;
			continue;
		}

		if (ch === '"' && !inSingle) {
			if (raw) current += ch;
			inDouble = !inDouble;
			started = true;
			continue;
		}

		if (!inSingle && !inDouble && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}

		current += ch;
		started = true;
	}

	if (started) tokens.push(current);
	return tokens;
}

/**
 * Split a command line into pipeline segments, respecting quotes. Splits on
 * `&&`, `||`, `;`, `|`, `&` (cmd.exe's sequencing operator and the POSIX
 * background operator) and line breaks, none of them inside a quoted token.
 */
export function splitPipeline(input: string, escapes = "\\"): string[] {
	return splitSequence(input, escapes).map((s) => s.text);
}

/** What joins a segment to its neighbours; `start` and `end` are the line's edges. */
type Separator = "start" | "end" | "&&" | "||" | ";" | "|" | "&" | "\n" | "\r";

interface SequencedSegment {
	text: string;
	before: Separator;
	after: Separator;
}

/** {@link splitPipeline}, keeping the operator on each side of every segment. */
function splitSequence(input: string, escapes: string): SequencedSegment[] {
	const segments: SequencedSegment[] = [];
	let current = "";
	let before: Separator = "start";
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	const cut = (after: Separator) => {
		segments.push({ text: current.trim(), before, after });
		current = "";
		before = after;
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		const next = input[i + 1];

		if (escape) {
			current += ch;
			escape = false;
			continue;
		}

		if (escapes.includes(ch) && !inSingle) {
			current += ch;
			escape = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}

		if (!inSingle && !inDouble) {
			if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
				cut(ch === "&" ? "&&" : "||");
				i++;
				continue;
			}
			if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
				cut(ch);
				continue;
			}
		}

		current += ch;
	}

	cut("end");
	return segments.filter((s) => s.text.length > 0);
}

// ============================================
// File-path extraction from shell commands
// ============================================

/**
 * One way a shell may read a command line: which characters escape the next
 * one, and whether `%VAR%` and `$env:VAR` expand.
 */
interface ShellReading {
	escapes: string;
	windowsVars: boolean;
}

const POSIX_SHELL: ShellReading = { escapes: "\\", windowsVars: false };
const WINDOWS_SHELL: ShellReading = { escapes: "^`", windowsVars: true };

/**
 * On Windows the agent's shell may be sh (Git Bash), cmd.exe or PowerShell,
 * so the line is read every way and a path that escapes under any reading is
 * a violation.
 */
function readings(platform: NodeJS.Platform): ShellReading[] {
	return platform === "win32" ? [POSIX_SHELL, WINDOWS_SHELL] : [POSIX_SHELL];
}

/** Argv tokens that look like file paths to a heuristic eye. */
function looksLikePath(token: string, platform: NodeJS.Platform): boolean {
	if (token.length === 0) return false;
	if (token.includes("$") || token.includes("`")) return true; // suspicious expansion
	if (platform === "win32" && (token.includes("\\") || /^[A-Za-z]:/.test(token))) return true;
	return (
		token === ".." ||
		token === "." ||
		token.includes("/") ||
		// bare filename with extension — still worth checking against cwd
		/\.[A-Za-z0-9]+$/.test(token)
	);
}

/**
 * The operand side of an argv token, or `null` for a bare flag. `--out=x`
 * yields `x`, and on Windows so does PowerShell's `-Path:x`.
 */
function operandOf(token: string, platform: NodeJS.Platform): string | null {
	if (token.startsWith("-")) {
		const eq = token.indexOf("=");
		if (eq !== -1) return token.slice(eq + 1);
		const colon = token.indexOf(":");
		if (platform === "win32" && colon !== -1) return token.slice(colon + 1);
		return null;
	}
	const eq = token.indexOf("=");
	return eq === -1 ? token : token.slice(eq + 1);
}

function envLookup(env: HomeEnv, name: string, platform: NodeJS.Platform): string | undefined {
	if (platform !== "win32") return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
	return key === undefined ? undefined : env[key];
}

// ============================================
// Variables the command line assigns itself (#4173)
// ============================================

/**
 * `D=<dir>; mkdir -p "$D/frames"` sets `D` before the shell expands `$D`, so
 * the check has to read `$D` from that assignment, not from the host
 * environment. Only what can be read with certainty is resolved: a plain
 * assignment statement that always runs in this shell, whose value is a word
 * with no command substitution. Every other way a line can set a variable it
 * also assigns plainly leaves that variable unresolved, and a path built from
 * an unresolved variable is refused as if it were outside the workspace.
 */
interface InlineAssignment {
	segment: number;
	word: number;
	name: string;
	/** The raw value text, or `null` for a bare `export NAME`. */
	value: string | null;
}

interface InlinePlan {
	assignments: InlineAssignment[];
	/** Assigned names whose value the check cannot know. */
	unresolved: Set<string>;
	/** Every assigned name is unresolved: the line runs code or opens subshells the check does not parse. */
	allUnresolved: boolean;
	/** The line sets IFS, so unquoted expansions may split anywhere. */
	ifs: boolean;
	/** The line sets HOME, so `~` no longer means the host's home. */
	home: boolean;
	/** The line sets CDPATH, so `cd` may land somewhere other than its operand. */
	cdpath: boolean;
	/** The line sets OLDPWD, so `cd -` may land anywhere. */
	oldpwd: boolean;
	/** The line has a `${NAME...}` form beyond plain `${NAME}` outside single quotes. */
	paramOps: boolean;
	/** `for NAME in a b` variables over plain words: each value is checked in turn. */
	loops: Map<string, string[]>;
}

const NO_INLINE: InlinePlan = {
	assignments: [],
	unresolved: new Set(),
	allUnresolved: false,
	ifs: false,
	home: false,
	cdpath: false,
	oldpwd: false,
	paramOps: false,
	loops: new Map(),
};

const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const NAME_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The options a POSIX `cd` reads ahead of its operand. */
const CD_OPTION = /^-[LPe@]+$/;
/** An assignment runs in this shell only when it starts a list... */
const LIST_START = new Set<Separator>(["start", ";", "\n", "\r"]);
/** ...and is not piped or sent to the background. */
const LIST_END = new Set<Separator>(["end", ";", "\n", "\r", "&&"]);
const OPENS_BODY = new Set(["if", "while", "until", "for", "case", "select", "{"]);
const CLOSES_BODY = new Set(["fi", "done", "esac", "}"]);
/** Reserved words that may start a segment ahead of the command it runs: `do cd x`, `then D=y`. */
const KEYWORD_PREFIX = new Set([
	"if",
	"while",
	"until",
	"{",
	"do",
	"then",
	"else",
	"elif",
	"!",
	"time",
	...CLOSES_BODY,
]);

/** How many reserved words start this argv before the command itself. */
function leadingKeywords(argv: string[]): number {
	let lead = 0;
	while (lead < argv.length && KEYWORD_PREFIX.has(argv[lead])) lead++;
	return lead;
}
/** Builtins that run code the check never sees, and may set any variable. */
const RUNS_CODE = new Set(["eval", "source", ".", "trap", "alias", "enable"]);
/** A function body runs where it is called, not where it is written. */
const DEFINES_CODE = new Set(["function"]);
/** `$NAME` or `${NAME}` (plain or with an operator): the name it reads. */
const REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/** A parameter expansion other than plain `${NAME}`: `${D:-x}`, `${D%/}`, `${!D}`, `${D[0]}`. */
const PARAM_OPERATOR = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/;
/** At most this many loop-value combinations are checked for one word. */
const MAX_LOOP_COMBINATIONS = 256;

/**
 * One word of a `for NAME in ...` list as the value the loop binds, or `null`
 * when the shell would expand or split it (a variable, `~`, braces, whitespace).
 * A glob stays a glob, so `$f` from `for f in *.png` is checked as `*.png` is.
 */
function loopValue(raw: string): string | null {
	const quoted = /^'([^']*)'$/.exec(raw) ?? /^"([^"$`\\]*)"$/.exec(raw);
	const value = quoted ? quoted[1] : raw;
	return /^[^\s'"$`\\{}~]+$/.test(value) ? value : null;
}
/** Shell-maintained: a plain assignment is overwritten by the next `cd`. */
const SHELL_MAINTAINED = new Set(["PWD", "OLDPWD"]);

/**
 * The leading `NAME=value` words of a segment (after `export` or `readonly`),
 * and whether they are the whole segment. When they are not, the segment is
 * either a prefix assignment (`D=x cmd`) or a value the word split cut short
 * (`D=$(echo /etc)`); neither can be resolved.
 */
function leadingAssignments(raw: string[]): {
	assignments: { word: number; name: string; value: string | null }[];
	statement: boolean;
} {
	const declared = raw[0] === "export" || raw[0] === "readonly";
	const assignments: { word: number; name: string; value: string | null }[] = [];
	for (let i = declared ? 1 : 0; i < raw.length; i++) {
		const m = ASSIGNMENT_WORD.exec(raw[i]);
		if (m) assignments.push({ word: i, name: m[1], value: m[2] });
		else if (declared && NAME_WORD.test(raw[i]))
			assignments.push({ word: i, name: raw[i], value: null });
		else return { assignments, statement: false };
	}
	return { assignments, statement: true };
}

/** The line with single-quoted text and escaped characters blanked out; double-quoted text still expands. */
function expandable(command: string): string {
	let out = "";
	let inSingle = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			out += "  ";
			i++;
		} else if (ch === "'") {
			inSingle = !inSingle;
			out += " ";
		} else out += inSingle ? " " : ch;
	}
	return out;
}

/** The line with quoted text and escaped characters blanked out. */
function unquoted(command: string): string {
	let out = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			out += "  ";
			i++;
		} else if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			out += " ";
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			out += " ";
		} else out += inSingle || inDouble ? " " : ch;
	}
	return out;
}

function count(text: string, pattern: string): number {
	return text.match(new RegExp(pattern, "g"))?.length ?? 0;
}

/** Every appearance of `name` as a whole word. */
function mentions(command: string, name: string): number {
	return count(command, `(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
}

/** Appearances of `name` as a plain `$name` or `${name}` reference. */
function references(command: string, name: string): number {
	return (
		count(command, `(?<![$\\\\])\\$${name}(?![A-Za-z0-9_])`) +
		count(command, `(?<![$\\\\])\\$\\{${name}\\}`)
	);
}

function planInlineAssignments(command: string, segments: SequencedSegment[]): InlinePlan {
	const plan: InlinePlan = {
		...NO_INLINE,
		assignments: [],
		unresolved: new Set(),
		loops: new Map(),
	};
	const assigned = new Map<string, number>();
	let depth = 0;
	let runsCode = false;
	const loopHeads = new Map<string, number>();
	const loopValues = new Map<string, string[] | null>();
	/**
	 * Names a reference may read while no loop has bound them: before the
	 * loop, or after one that may not have run (`false && for`, `if x; then
	 * for ... fi`) or ran in a subshell (`done | cat`, `done &`).
	 */
	const unbound = new Set<string>();
	/** The open bodies, outermost first: the loop a body belongs to, and the loops finished in it. */
	const frames: { loop?: string; certain?: boolean; settled: Set<string> }[] = [
		{ settled: new Set() },
	];
	const isBound = (name: string) => frames.some((f) => f.loop === name || f.settled.has(name));

	segments.forEach((segment, index) => {
		const raw = words(segment.text, POSIX_SHELL.escapes, true);
		const lead = leadingKeywords(raw);
		const finished: [Set<string>, string][] = [];
		for (const keyword of raw.slice(0, lead)) {
			if (CLOSES_BODY.has(keyword)) {
				depth = Math.max(0, depth - 1);
				const closed = frames.length > 1 ? frames.pop() : undefined;
				// A loop that surely ran in this shell leaves its name bound for the rest of the body.
				if (closed?.loop && closed.certain && keyword === "done" && LIST_END.has(segment.after)) {
					finished.push([frames[frames.length - 1].settled, closed.loop]);
				}
			}
			if (OPENS_BODY.has(keyword)) {
				depth++;
				frames.push({ settled: new Set() });
			}
			// `else` and `elif` start a branch the loops in `then` never ran for.
			if (keyword === "else" || keyword === "elif") frames[frames.length - 1].settled.clear();
		}
		// A redirect on `done > $f/x` expands before the loop runs, so it is read unbound.
		for (const [, name] of segment.text.matchAll(REFERENCE)) {
			if (!isBound(name)) unbound.add(name);
		}
		for (const [settled, name] of finished) settled.add(name);
		const head = raw[lead];
		if (
			RUNS_CODE.has(head) ||
			((head === "command" || head === "builtin") && RUNS_CODE.has(raw[lead + 1]))
		) {
			plan.allUnresolved = true;
			runsCode = true;
		}
		if (DEFINES_CODE.has(head)) plan.allUnresolved = true;
		if ((head === "for" || head === "select") && NAME_WORD.test(raw[lead + 1] ?? "")) {
			const name = raw[lead + 1];
			loopHeads.set(name, (loopHeads.get(name) ?? 0) + 1);
			const values = raw[lead + 2] === "in" ? raw.slice(lead + 3).map(loopValue) : [null];
			const known = loopValues.get(name);
			// `for f in; do` binds nothing: `$f` keeps whatever it held before, so it is unresolved.
			loopValues.set(
				name,
				known === null || values.length === 0 || values.includes(null)
					? null
					: [...(known ?? []), ...(values as string[])],
			);
		}
		const { assignments, statement } = leadingAssignments(raw.slice(lead));
		const certain =
			statement && depth === 0 && LIST_START.has(segment.before) && LIST_END.has(segment.after);
		for (const a of assignments) {
			plan.assignments.push({ segment: index, ...a, word: a.word + lead });
			assigned.set(a.name, (assigned.get(a.name) ?? 0) + 1);
			if (!certain || SHELL_MAINTAINED.has(a.name)) plan.unresolved.add(a.name);
		}
		if (head !== undefined && OPENS_BODY.has(head)) {
			depth++;
			// Only `for` binds a listed value: `select` sets its name to "" on input that picks nothing.
			const loop = head === "for" ? raw[lead + 1] : undefined;
			// A glob may match nothing (`nullglob`, also set through BASHOPTS), so the loop may not run.
			const globbed = raw.slice(lead + 3).some((w) => /[*?[]/.test(w));
			frames.push({
				loop,
				certain: LIST_START.has(segment.before) && !globbed,
				settled: new Set(),
			});
		}
	});

	// Subshells, command substitution, arrays, case arms and heredocs: the
	// segments above are not the shell's real structure.
	const bare = unquoted(command).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "");
	if (/[()`]|<</.test(bare)) plan.allUnresolved = true;

	// A name set any other way as well (`read D`, `for D in`, `D+=x`,
	// `${D:=x}`, `unset D`) cannot be trusted.
	for (const [name, times] of assigned) {
		if (mentions(command, name) !== references(command, name) + times) plan.unresolved.add(name);
	}

	// A name the line reads but never assigns plainly is still the host's only
	// if nothing on the line can set it: `read D`, `for D in $(cat f)`,
	// `printf -v D`, or code the check never sees (`source`, `eval`).
	// A `for` variable over plain words is the only exception: it takes each
	// of those values in turn, so each is checked.
	for (const [, name] of command.matchAll(REFERENCE)) {
		if (assigned.has(name)) continue;
		const extra = mentions(command, name) - references(command, name);
		if (extra === 0 && !runsCode) continue;
		const values = loopValues.get(name);
		const bound = !unbound.has(name);
		if (!runsCode && values && bound && extra === loopHeads.get(name)) plan.loops.set(name, values);
		else plan.unresolved.add(name);
	}

	const setsAnyWay = (name: string) => mentions(command, name) > references(command, name);
	plan.ifs = setsAnyWay("IFS");
	plan.home = setsAnyWay("HOME");
	plan.cdpath = setsAnyWay("CDPATH");
	plan.oldpwd = setsAnyWay("OLDPWD");
	plan.paramOps = PARAM_OPERATOR.test(expandable(command));
	if (plan.ifs) {
		plan.allUnresolved = true;
		for (const name of plan.loops.keys()) plan.unresolved.add(name);
		plan.loops.clear();
	}
	return plan;
}

/** How the variables in a word are read. */
interface ExpandScope {
	/** Names this line assigned so far, with their value or `null` if unresolvable. */
	locals: ReadonlyMap<string, string | null>;
	/** Reading an assignment value: a variable set nowhere makes it unresolvable instead of empty. */
	strict?: boolean;
	/** The line sets HOME: `~` is unresolvable. */
	homeReassigned?: boolean;
	/** The line has `${NAME...}` operator forms: any word still holding `${` is unresolvable. */
	paramOps?: boolean;
}

interface Expansion {
	text: string;
	/** A variable in the word has no value the check can know. */
	unresolved: boolean;
	/** A variable in the word came from this line, not the host environment. */
	local: boolean;
}

const HOST_ONLY: ExpandScope = { locals: new Map() };

/**
 * Expand `~`, `$VAR`, `${VAR}` and, for a Windows shell, `%VAR%` and
 * `$env:VAR` the way the shell will before the command sees them, so a path
 * rooted in the user's profile is checked where it really points. A variable
 * the line assigned itself reads from that assignment; any other unset
 * `$VAR` expands to nothing, and an unset `%VAR%` stays literal, as in cmd.exe.
 */
function expand(
	token: string,
	host: BoundaryHost,
	reading: ShellReading,
	scope: ExpandScope = HOST_ONLY,
): Expansion {
	const { env, platform } = host;
	let unresolved = false;
	let local = false;
	let out = token;
	if (reading.windowsVars) {
		out = out.replace(
			/%([A-Za-z_][A-Za-z0-9_()]*)%/g,
			(m, name) => envLookup(env, name, platform) ?? m,
		);
		out = out.replace(
			/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi,
			(_, name) => envLookup(env, name, platform) ?? "",
		);
	}
	out = out.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(_, braced, bare) => {
			const name: string = braced ?? bare;
			if (scope.locals.has(name)) {
				local = true;
				const value = scope.locals.get(name);
				if (value == null) unresolved = true;
				return value ?? "";
			}
			const value = envLookup(env, name, platform);
			if (value === undefined && scope.strict) unresolved = true;
			return value ?? "";
		},
	);
	if (scope.paramOps && out.includes("${")) unresolved = true;
	const tilde = (platform === "win32" ? /^~([^/\\]*)(?=$|[/\\])/ : /^~([^/]*)(?=$|\/)/).exec(out);
	if (tilde) {
		if (scope.homeReassigned) unresolved = true;
		const home = resolveHome(env, platform);
		const flavor = pathFor(platform);
		const base = tilde[1] ? flavor.join(flavor.dirname(home), tilde[1]) : home;
		out = base + out.slice(tilde[0].length);
	}
	return { text: out, unresolved, local };
}

/**
 * The value a plain assignment gives its variable, or `null` when the check
 * cannot know it: command substitution, a variable set nowhere, any other
 * `$` form, or whitespace an unquoted expansion would split into more words.
 */
function assignedValue(
	raw: string,
	host: BoundaryHost,
	locals: ReadonlyMap<string, string | null>,
	homeReassigned: boolean,
): string | null {
	if (raw.includes("$(") || raw.includes("`")) return null;
	const word = words(raw, POSIX_SHELL.escapes, false)[0] ?? "";
	const value = expand(word, host, POSIX_SHELL, { locals, strict: true, homeReassigned });
	if (value.unresolved || value.text.includes("$") || /\s/.test(value.text)) return null;
	return value.text;
}

/**
 * Walk a command line, collect every path-like argument across pipeline
 * segments, and check each one against the workspace root. Tracks `cd`
 * statements so paths in later segments are anchored to the chained cwd
 * (the holaOS attack surface), and variables the line assigns so `$VAR`
 * is checked where the shell will really point it.
 */
export function extractAndCheckPaths(
	command: string,
	options: ExtractOptions,
): BoundaryCheckResult {
	const host = hostOf(options.host);
	const { platform } = host;
	const { workspaceRoot, allowedAbsolutePrefixes } = options;
	const violations = new Map<string, BoundaryViolation>();
	const flag = (raw: string, resolved: string, reason: string) => {
		violations.set(`${raw}\0${resolved}`, { raw, resolved, reason });
	};
	const delimiter = pathFor(platform).delimiter;
	const unknown = `uses a variable this command sets in a way the boundary cannot follow (command substitution, an unset variable, whitespace, a loop or a second assignment), so it is treated as outside the workspace root (${workspaceRoot}); set it once with a plain NAME=value statement instead`;

	for (const reading of readings(platform)) {
		const segments = splitSequence(command, reading.escapes);
		// Only a POSIX shell reads `NAME=value` as an assignment.
		const plan = reading === POSIX_SHELL ? planInlineAssignments(command, segments) : NO_INLINE;
		const locals = new Map<string, string | null>();
		// A name the shell may rebind before a reference runs (a loop body, a
		// function, `read`, `source`) is unknowable from its first appearance on.
		for (const name of plan.unresolved) locals.set(name, null);
		if (plan.allUnresolved) for (const a of plan.assignments) locals.set(a.name, null);
		const scope: ExpandScope = { locals, homeReassigned: plan.home, paramOps: plan.paramOps };
		let cwd = workspaceRoot;
		/** The directory before the last `cd` on this line; `null` until one runs. */
		let previous: string | null = null;

		/**
		 * The scopes a word must be checked under: one, or one per combination
		 * of the `for` values it reads; `null` when there are too many.
		 */
		const scopesFor = (word: string): ExpandScope[] | null => {
			let scopes: ExpandScope[] = [scope];
			const names = new Set([...word.matchAll(REFERENCE)].map((m) => m[1]));
			for (const name of names) {
				const values = plan.loops.get(name);
				if (!values) continue;
				if (scopes.length * values.length > MAX_LOOP_COMBINATIONS) return null;
				scopes = scopes.flatMap((s) =>
					values.map((v) => ({ ...s, locals: new Map([...s.locals, [name, v]]) })),
				);
			}
			// No scope at all would check nothing: treat it as unresolved.
			return scopes.length > 0 ? scopes : null;
		};

		const checkToken = (token: string): void => {
			const operand = operandOf(token, platform);
			if (operand === null) return;
			const scopes = scopesFor(operand);
			if (scopes === null) {
				flag(token, "<unresolved>", `Path argument ${unknown}`);
				return;
			}
			for (const s of scopes) checkOperand(token, operand, s);
		};

		const checkOperand = (token: string, operand: string, scope: ExpandScope): void => {
			const candidate = expand(operand, host, reading, scope);
			if (candidate.unresolved) {
				flag(token, "<unresolved>", `Path argument ${unknown}`);
				return;
			}
			// `echo $PATH` names a search list, not a file - unless IFS splits it.
			const searchList = candidate.text !== operand && candidate.text.includes(delimiter);
			if (searchList && !candidate.local && !plan.ifs) return;
			if (!looksLikePath(candidate.text, platform)) return;

			const resolved = resolveSafe(candidate.text, cwd, platform);
			if (isConfined(resolved, workspaceRoot, allowedAbsolutePrefixes, platform)) return;
			flag(token, resolved, `Path argument escapes workspace root (${workspaceRoot})`);
		};

		segments.forEach((segment, index) => {
			const argv = tokenize(segment.text, reading.escapes);
			if (argv.length === 0) return;

			// `do cd x`, `then cd x`: the reserved words are not the command.
			const lead = reading === POSIX_SHELL ? leadingKeywords(argv) : 0;
			let first = 1;
			const isCd = argv[lead]?.toLowerCase() === "cd";
			// A POSIX `cd` takes options (`-P`, `-L`, `-e`, `-@`, `--`) before its operand.
			let at = lead + 1;
			if (isCd && reading === POSIX_SHELL) {
				while (CD_OPTION.test(argv[at] ?? "")) at++;
				if (argv[at] === "--") at++;
			}
			if (isCd && argv.length === at && reading === POSIX_SHELL) {
				// A bare `cd` goes to $HOME.
				const home = expand("~", host, reading, scope);
				const resolved = resolveSafe(home.text, cwd, platform);
				if (home.unresolved) {
					flag(argv[lead], "<unresolved>", `cd target ${unknown}`);
				} else if (!isConfined(resolved, workspaceRoot, allowedAbsolutePrefixes, platform)) {
					flag(argv[lead], resolved, `cd target escapes workspace root (${workspaceRoot})`);
				}
				previous = cwd;
				cwd = resolved;
				first = at;
			} else if (isCd && argv.length > at) {
				// cmd.exe's `cd /d <dir>` also switches drive.
				const hasDriveSwitch =
					platform === "win32" && argv.length >= 3 && argv[1].toLowerCase() === "/d";
				if (hasDriveSwitch) at = lead + 2;
				const operand = operandOf(argv[at], platform) ?? argv[at];
				// A `cd` into a loop variable lands in one place only if the loop has one value.
				const scopes = scopesFor(operand);
				const target = expand(operand, host, reading, scopes?.[0] ?? scope);
				// `cd -` goes to $OLDPWD, also when a variable expands to `-` (`D=-; cd $D`).
				const back =
					operand === "-" || (scopes?.length === 1 && !target.unresolved && target.text === "-");
				if (back) {
					// $OLDPWD is known only after a `cd` on this line set it.
					if (previous === null || plan.oldpwd) {
						flag(argv[at], "<unresolved>", `cd target ${unknown}`);
					}
					[previous, cwd] = [cwd, previous ?? cwd];
				} else {
					const resolved = resolveSafe(target.text, cwd, platform);
					if (target.unresolved || plan.cdpath || scopes?.length !== 1) {
						flag(argv[at], "<unresolved>", `cd target ${unknown}`);
					} else if (!isConfined(resolved, workspaceRoot, allowedAbsolutePrefixes, platform)) {
						flag(argv[at], resolved, `cd target escapes workspace root (${workspaceRoot})`);
					}
					previous = cwd;
					cwd = resolved;
				}
				first = at + 1;
			}

			argv.forEach((token, word) => {
				if (word >= first) checkToken(token);
				const assignment = plan.assignments.find((a) => a.segment === index && a.word === word);
				if (assignment && assignment.value !== null) {
					const untrusted = plan.allUnresolved || plan.unresolved.has(assignment.name);
					locals.set(
						assignment.name,
						untrusted ? null : assignedValue(assignment.value, host, locals, plan.home),
					);
				}
			});
		});
	}

	return { allowed: violations.size === 0, violations: [...violations.values()] };
}

// ============================================
// Public entry points
// ============================================

/**
 * Pre-check gate for file-system tool actions (write_file / read_file /
 * delete_file). Returns a list of violations or an empty array if the path
 * is safely confined.
 */
export function checkFilePathBoundary(
	rawPath: string,
	workspaceRoot: string,
	allowedAbsolutePrefixes?: string[],
	host?: Partial<BoundaryHost>,
): BoundaryCheckResult {
	return checkPath(rawPath, workspaceRoot, { allowedAbsolutePrefixes, host });
}

/**
 * Pre-check gate for shell `run_command` actions. Tokenizes the command and
 * verifies every path-like argument (including `cd` targets in chained
 * pipelines) stays inside the workspace root.
 */
export function checkCommandBoundary(
	command: string,
	workspaceRoot: string,
	allowedAbsolutePrefixes?: string[],
	host?: Partial<BoundaryHost>,
): BoundaryCheckResult {
	return extractAndCheckPaths(command, { workspaceRoot, allowedAbsolutePrefixes, host });
}
