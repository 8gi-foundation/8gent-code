/**
 * `@` file mentions in the prompt (#3918, Pi gap D2).
 *
 * Typing `@` then part of a name lists the project's files that match, best
 * first; Up/Down picks one and Tab puts its path into the message as
 * `@path/to/file`. The file list is `git ls-files` (tracked plus untracked,
 * minus ignored), or a bounded walk outside a git repo.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The `@token` being typed at the end of the input, or null. A `!` shell line
 * has no mentions: `@` there is the shell's (#3918 D5, 8SO).
 */
export function mentionAtEnd(value: string): { query: string; start: number } | null {
	if (value.trimStart().startsWith("!")) return null;
	const m = value.match(/(?:^|\s)@([^\s@]*)$/);
	if (!m || m.index === undefined) return null;
	const start = value.length - m[1].length - 1;
	return { query: m[1], start };
}

/** Replace the `@token` that starts at `start` with `@file` and a space. */
export function applyMention(value: string, start: number, file: string): string {
	const shown = /\s/.test(file) ? `"${file}"` : file;
	return `${value.slice(0, start)}@${shown} `;
}

function subsequenceScore(text: string, q: string): number | null {
	let score = 0;
	let qi = 0;
	let prev = -2;
	for (let i = 0; i < text.length && qi < q.length; i++) {
		if (text[i] !== q[qi]) continue;
		score += 1;
		if (i === prev + 1) score += 3;
		if (i === 0 || "/._-".includes(text[i - 1])) score += 4;
		prev = i;
		qi++;
	}
	return qi < q.length ? null : score;
}

/**
 * Fuzzy score of `file` for `query`: every query character must appear in
 * order. A match inside the file name beats one spread over the folders,
 * runs of characters and word starts score more, a name that starts with the
 * query scores most, and shorter paths win ties. Null when it does not match.
 */
export function scoreFile(file: string, query: string): number | null {
	if (!query) return -file.length;
	const q = query.toLowerCase();
	const f = file.toLowerCase();
	const name = path.posix.basename(f);
	const inName = q.includes("/") ? null : subsequenceScore(name, q);
	let score: number;
	if (inName !== null) {
		score = inName + 20 + (name.startsWith(q) ? 10 : 0);
	} else {
		const inPath = subsequenceScore(f, q);
		if (inPath === null) return null;
		score = inPath;
	}
	return score * 100 - file.length;
}

export function rankFiles(files: readonly string[], query: string, limit = 8): string[] {
	const scored: { file: string; score: number }[] = [];
	for (const file of files) {
		const score = scoreFile(file, query);
		if (score !== null) scored.push({ file, score });
	}
	scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
	return scored.slice(0, limit).map((s) => s.file);
}

const MAX_FILES = 50_000;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\x00-\x1f\x7f]/;

/** Keep names a terminal can draw safely: no ESC or other control bytes. */
export function safeNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	for (const n of names) {
		if (n && !CONTROL.test(n)) out.push(n);
		if (out.length >= MAX_FILES) break;
	}
	return out;
}

/** Files under `root` (no dot-directories, no build output), bounded. */
async function walk(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack = [""];
	while (stack.length > 0 && out.length < MAX_FILES) {
		const rel = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) stack.push(child);
			} else if (e.isFile()) {
				out.push(child);
			}
		}
	}
	return out;
}

function gitLsFiles(cwd: string): Promise<string[] | null> {
	return new Promise((resolve) => {
		try {
			execFile(
				"git",
				["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
				{ cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 5000, windowsHide: true },
				(err, stdout) => resolve(err ? null : stdout.split("\0")),
			);
		} catch {
			resolve(null);
		}
	});
}

/**
 * The project's files, relative to `cwd`, with `/` separators: `git ls-files`
 * in a repo, else a bounded walk. Never walks the home directory itself.
 * Names with control characters are dropped.
 */
export async function listProjectFiles(cwd: string, home = os.homedir()): Promise<string[]> {
	const fromGit = await gitLsFiles(cwd);
	if (fromGit) return safeNames(fromGit);
	if (path.resolve(cwd) === path.resolve(home)) return [];
	return safeNames(await walk(cwd));
}
