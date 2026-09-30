/**
 * System One: the files this session created (#3177).
 *
 * The pilot makes scratch files (`bun test > bunout.txt`) and then removes
 * them (`rm -f bunout.txt`). That rm fires rule rm_non_temp, so it went to the
 * judge. An agent removing a file it made itself a moment ago is not the risk
 * the judge is there for, so the gate lets it through without the judge when
 * this record says the session created the file (see s1-rm-nothing.ts for
 * every other condition).
 *
 * What counts as "created by this session":
 *   - write_file writing a path that did not exist just before the write;
 *   - a run_command whose `>` / `>>` redirect names a plain relative path that
 *     did not exist just before the command and is a regular file after it.
 * Both tool paths (packages/eight/tools.ts, packages/ai/tools.ts) record into
 * the same object: one per ToolExecutor, which the Agent also hands to its
 * native tool context. A different agent, tab or child has its own record.
 *
 * In memory only, never written to disk. Each entry keeps the file's identity
 * (device, inode, change and birth time, size), so a file that was since
 * replaced or changed by something else no longer counts. The session's own
 * later writes to a recorded file (write_file, edit_file, a redirect) refresh
 * the entry.
 *
 * A file that existed before the session wrote to it is never recorded: an
 * overwrite or a `>` truncation of a pre-existing file is a modification, not
 * a creation.
 *
 * Known window: a process other than the command could create a redirect
 * target while the command runs; it would then be recorded. The agent's own
 * tool calls are serial, so only its background tasks could do that.
 */

import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { maskQuotes } from "../decide/rules";

/** The words a recorded path may contain: no quotes, glob, `$`, `~`, spaces. */
const PLAIN_PATH = /^[A-Za-z0-9._/+,=@:-]+$/;

/**
 * What makes a file "that same file". Device and inode alone are not enough:
 * Linux hands a freed inode straight to the next file created, so a delete and
 * recreate at the same path can keep both (the Linux CI job caught this). The
 * change time and birth time in nanoseconds and the size move when a file is
 * recreated. The session's own writes refresh the entry, so they never count
 * as a replacement.
 */
type Identity = string;

/** Canonical key: the realpath of the parent directory plus the base name; null when the parent does not resolve. */
function keyOf(abs: string): string | null {
	try {
		return path.join(realpathSync(path.dirname(abs)), path.basename(abs));
	} catch {
		return null;
	}
}

/** The identity of `abs` when it is a regular file (not a symlink, not a directory), else null. */
function regularFile(abs: string): Identity | null {
	try {
		const st = lstatSync(abs, { bigint: true });
		return st.isFile() ? [st.dev, st.ino, st.ctimeNs, st.birthtimeNs, st.size].join(":") : null;
	} catch {
		return null;
	}
}

/** True when nothing exists at `abs` (lstat ENOENT; a dangling symlink exists). */
export function pathAbsent(abs: string): boolean {
	try {
		lstatSync(abs);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "ENOENT";
	}
}

export class CreatedFiles {
	private readonly files = new Map<string, Identity>();

	/** Record `abs` as created by this session, if it is now a regular file. */
	record(abs: string): void {
		const key = keyOf(abs);
		const id = regularFile(abs);
		if (key && id) this.files.set(key, id);
	}

	/** The session wrote `abs` again: keep its entry pointing at the file as it now is. */
	refresh(abs: string): void {
		const key = keyOf(abs);
		if (!key || !this.files.has(key)) return;
		const id = regularFile(abs);
		if (id) this.files.set(key, id);
		else this.files.delete(key);
	}

	/** True when `abs` is a regular file this session created, and still that same file. */
	createdBySession(abs: string): boolean {
		const key = keyOf(abs);
		if (!key) return false;
		const want = this.files.get(key);
		const now = regularFile(abs);
		return !!want && !!now && want === now;
	}

	get size(): number {
		return this.files.size;
	}
}

/**
 * Bracket one write: call before it, and call the result after it succeeds.
 * A path that did not exist is recorded; a path already recorded is refreshed.
 */
export function watchWrite(abs: string, record: CreatedFiles | undefined): () => void {
	if (!record) return () => {};
	const wasAbsent = pathAbsent(abs);
	return () => {
		try {
			if (wasAbsent) record.record(abs);
			else record.refresh(abs);
		} catch {
			// Recording is best effort; it never affects the write.
		}
	};
}

/**
 * The plain relative paths `command` redirects output into with `>` or `>>`
 * (also `1>`, `2>`, `&>`). Targets in quotes, with `$`, `~`, a glob, an
 * absolute path or a `..` segment are left out: they are never recorded.
 */
export function redirectTargets(command: string): string[] {
	const masked = maskQuotes(command);
	const out: string[] = [];
	for (const m of masked.matchAll(/(?:\d|&)?>>?\|?[ \t]*([^\s;|&<>()]+)/g)) {
		const target = m[1] ?? "";
		const at = (m.index ?? 0) + m[0].length - target.length;
		// Masking changed it: part of it was quoted.
		if (command.slice(at, at + target.length) !== target) continue;
		if (!PLAIN_PATH.test(target) || target.startsWith("/") || target.split("/").includes(".."))
			continue;
		out.push(target);
	}
	return out;
}

/**
 * Bracket one shell command: call before it runs, and call the result after
 * it exits. Its plain redirect targets that did not exist before are recorded
 * if they are regular files after; ones already recorded are refreshed.
 */
export function watchRedirects(
	command: string,
	cwd: string,
	record: CreatedFiles | undefined,
): () => void {
	if (!record) return () => {};
	const watches: Array<() => void> = [];
	try {
		for (const t of redirectTargets(command))
			watches.push(watchWrite(path.resolve(cwd, t), record));
	} catch {
		return () => {};
	}
	return () => {
		for (const w of watches) w();
	};
}
