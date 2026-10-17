/**
 * One leading `cd <folder> &&` (or `cd <folder>;`) on run_command (#3199).
 *
 * A newcomer's model writes `cd site && npm init -y`. The sanitizer refuses the
 * chain, a bare `cd site` does not carry to the next call, and the turn loops
 * for minutes. This module lets exactly that one shape through, without ever
 * handing the chained line to a shell: the folder becomes the spawn's working
 * directory and only the remainder runs, through every check it would face if
 * it had been sent alone (sanitizer, System One, policy, approval card).
 *
 * Accepted only when ALL hold:
 *   - the line is `cd`, one plain relative folder, then `&&` or `;`, then a remainder;
 *   - the folder word is letters, digits and `_ - . + @ /` only: no `..`, `$`, `~`,
 *     globs, quotes, backslashes or spaces, not absolute, not a flag;
 *   - no segment of the folder starts with `.` (a dot directory), a leading `./` aside;
 *   - its realpath is a directory strictly inside the realpath of the project root,
 *     and no segment of that realpath (relative to the root) starts with `.`, so a
 *     symlink out of the project or onto a dot directory is refused;
 *   - that realpath, relative to the root, is itself a plain folder word, so the card's
 *     `cd <folder> && <rest>` reads exactly as what runs (#4178);
 *   - the remainder is not itself a `cd` (two cds);
 *   - the shell is POSIX (bash, sh, Git Bash). PowerShell and cmd are left alone.
 *
 * Anything else that starts `cd ... &&` or `cd ...;` is refused here with the reason;
 * a line that does not start that way is untouched and meets the sanitizer as today.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ShellKind } from "../core/shell";

export type CdPrefix =
	/** No leading cd prefix: run the command as it is. */
	| { kind: "none" }
	/** Run `rest` with `dir` (a realpath inside the project) as its working directory. */
	| { kind: "cd"; dir: string; rest: string }
	/** It starts with `cd <x> &&` or `cd <x>;` but may not run that way. */
	| { kind: "refused"; message: string };

/** `cd`, a folder word, `&&` or `;`, then the rest. Loose on purpose: the folder is judged below. */
const CD_SHAPE = /^\s*cd[ \t]+([^;&\n]+?)[ \t]*(&&|;)[ \t]*([\s\S]*)$/;
/** Folder characters: letters, digits and `_ . @ + - /`, never a leading `-`. */
const PLAIN_FOLDER = /^[A-Za-z0-9_.@+/][A-Za-z0-9_.@+\-/]*$/;
/** A leading `./`, which is dropped. */
const LEADING_DOT_SLASH = /^\.\/+/;
/** The remainder starts another cd. */
const SECOND_CD = /^cd(\s|$)/;

const RULE =
	"Command chaining is not allowed. A leading `cd <folder> &&` works only for one plain folder inside the project";

/** The refusal text, in the sanitizer's [BLOCKED] form so chain-refusal counting sees it. */
function refuse(why: string, command: string): CdPrefix {
	return { kind: "refused", message: `[BLOCKED] ${RULE}: ${why}. Command: ${command}` };
}

function posix(kind: ShellKind | "posix"): boolean {
	return kind === "posix" || kind === "git-bash";
}

type Parsed = { folder: string; segs: string[]; rest: string } | { why: string } | null;

/** The text checks, shared by `cdPrefixShape` and `cdPrefix`. Null: not a cd prefix at all. */
function parse(command: string): Parsed {
	const m = CD_SHAPE.exec(command);
	if (!m) return null;
	const rest = (m[3] ?? "").trim();
	if (!rest) return { why: "nothing follows the cd" };
	if (SECOND_CD.test(rest)) return { why: "only one cd is allowed" };
	const folder = (m[1] ?? "").replace(LEADING_DOT_SLASH, "");
	if (!folder) return { why: "name a folder" };
	// `C:\x` and `C:/x` are absolute on Windows; the plain-name check would refuse them too,
	// but with the wrong reason.
	if (folder.startsWith("/") || /^[A-Za-z]:/.test(folder) || folder.startsWith("\\"))
		return { why: "the folder must be relative, not absolute" };
	if (!PLAIN_FOLDER.test(folder))
		return {
			why: "the folder must be a plain name (no $, ~, quotes, globs, spaces or a leading -)",
		};
	const segs = folder.split("/").filter((s) => s !== "");
	if (segs.includes("..")) return { why: "the folder may not go up with .." };
	if (segs.some((s) => s.startsWith("."))) return { why: "the folder may not be a dot directory" };
	return { folder, segs, rest };
}

/**
 * The folder and remainder when `command` has the cd-prefix SHAPE with a plain folder
 * word, before any filesystem check; null otherwise. For callers with no project root
 * (the loop breaker): a line this accepts may still be refused by `cdPrefix`.
 */
export function cdPrefixShape(
	command: string,
	kind: ShellKind | "posix" = "posix",
): { folder: string; rest: string } | null {
	if (!posix(kind)) return null;
	const p = parse(command);
	return p && "rest" in p ? { folder: p.folder, rest: p.rest } : null;
}

/**
 * `segs` spelled as the disk spells them. On a case-insensitive disk `cd VIDEO` finds
 * `video`, and realpath keeps the typed case on Windows, so every gate downstream would
 * be handed a name the disk does not have. A segment with no entry stays as typed.
 */
function onDiskNames(root: string, segs: string[]): string[] {
	const out: string[] = [];
	let cur = root;
	for (const seg of segs) {
		let name = seg;
		try {
			const names = readdirSync(cur);
			if (!names.includes(seg)) {
				const lower = seg.toLowerCase();
				name = names.find((n) => n.toLowerCase() === lower) ?? seg;
			}
		} catch {}
		out.push(name);
		cur = path.join(cur, name);
	}
	return out;
}

/** True when `child` is strictly inside `parent` (both realpaths). */
function strictlyInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Split one leading `cd <folder> &&` / `cd <folder>;` off `command`, judged against the
 * project `root`. See the module header for every condition.
 */
export function cdPrefix(
	command: string,
	root: string,
	kind: ShellKind | "posix" = "posix",
): CdPrefix {
	if (!posix(kind)) return { kind: "none" };
	const p = parse(command);
	if (!p) return { kind: "none" };
	if ("why" in p) return refuse(p.why, command);
	let realRoot: string;
	let dir: string;
	try {
		realRoot = realpathSync(root);
		dir = realpathSync(path.resolve(realRoot, ...onDiskNames(realRoot, p.segs)));
	} catch {
		return refuse(`there is no folder ${p.folder} in the project`, command);
	}
	// A symlink that leads out of the project, or back to its root.
	if (!strictlyInside(dir, realRoot))
		return refuse("the folder resolves outside the project", command);
	// A symlink onto a dot directory such as .git or .8gent.
	if (
		path
			.relative(realRoot, dir)
			.split(path.sep)
			.some((s) => s.startsWith("."))
	)
		return refuse("the folder resolves into a dot directory", command);
	// The card shows `cd <real folder> && <rest>` (#4178). A plain-named symlink onto a
	// folder named `a && b`, `a; x`, a line break, an escape code or a unicode space would
	// make that line read as something other than what runs, so the real folder must be
	// as plain as a typed one.
	if (!PLAIN_FOLDER.test(path.relative(realRoot, dir).split(path.sep).join("/")))
		return refuse("the folder resolves to a name that is not plain", command);
	let isDir = false;
	try {
		isDir = lstatSync(dir).isDirectory();
	} catch {}
	if (!isDir) return refuse(`${p.folder} is not a folder`, command);
	return { kind: "cd", dir, rest: p.rest };
}

/**
 * What a person approving a command is shown: the command, and after a leading
 * `cd <folder> &&` the folder it runs in, since `rm -rf old` means a different
 * thing in each folder. `where` is the folder relative to the project root.
 *
 * Folder first, `cd <folder> && <command>`, the shape the model wrote (#4178): every
 * card (TUI, channel, readline, System One escalation) cuts a long command at its end,
 * so a folder after the command was the first thing lost. Display only: policy,
 * System One and the per-folder answers still judge `command` with `where` beside it.
 */
export function commandInFolder(command: string, where?: string): string {
	if (!where) return command;
	// `cdPrefix` only yields plain folders; any other `where` is shown quoted and escaped,
	// never raw, so it cannot pose as a second command, a line break or an escape code.
	const shown = PLAIN_FOLDER.test(where)
		? where
		: JSON.stringify(where).replace(
				/[^\x20-\x7e]/g,
				(c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
			);
	return `cd ${shown} && ${command}`;
}

/**
 * The folder `dir` names relative to the project `root`, for the approval card and
 * the session's per-folder memory; undefined at the root itself.
 */
export function folderLabel(dir: string, root: string): string | undefined {
	let base = root;
	try {
		base = realpathSync(root);
	} catch {}
	const rel = path.relative(base, dir);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
		? rel.split(path.sep).join("/")
		: undefined;
}

/** `command` without a valid cd prefix, for checks that judge the text that will run. */
export function commandAfterCdPrefix(
	command: string,
	root: string,
	kind: ShellKind | "posix" = "posix",
): string {
	const cd = cdPrefix(command, root, kind);
	return cd.kind === "cd" ? cd.rest : command;
}

/**
 * Added to a chaining refusal of the rest after a valid `cd <folder> &&` (#4260). The
 * refusal used to name only the rest, so the model split it into bare pieces that ran
 * at the project root: `mkdir -p notes docs sheets` made folders beside inbox/, not in
 * it, and the files moved into the wrong place. Text only: nothing is allowed by it.
 */
export function chainInFolderNote(where: string): string {
	const prefix = commandInFolder("", where).trimEnd();
	return ` It was to run in ${prefix.slice(3, -3)}, and each run_command starts in the project folder, so begin every piece with \`${prefix}\`.`;
}

/** Appended to a run_command result when the same command text is refused for chaining twice in one turn. */
export const REFUSED_TWICE_LINE =
	"Refused twice. Chaining is not allowed; run the steps as separate commands, or prefix one `cd <folder> &&` to run inside a project folder.";
