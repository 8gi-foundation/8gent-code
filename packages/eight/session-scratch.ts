/**
 * The session's scratch directory, outside the repo (#4711).
 *
 * `$TMPDIR/8gent-<session id>/`: created at session start, removed at session end, named in
 * the system prompt so the model keeps scratch files there and not in the person's repo.
 */
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every scratch dir this process made and has not removed; one exit handler walks it. */
const live = new Set<string>();
let exitHandlerSet = false;

function removeAllAtExit(): void {
	for (const dir of [...live]) removeSessionScratch(dir);
}

export function sessionScratchPath(sessionId: string): string {
	return join(tmpdir(), `8gent-${sessionId}`);
}

/**
 * Creates the directory (mode 0700), not recursive: an existing path (a guessable name on a
 * shared temp dir) is EEXIST and gives null, so this session never owns, and never removes,
 * a directory it did not make. Returns its path, or null when it could not be made.
 */
export function createSessionScratch(sessionId: string): string | null {
	const dir = sessionScratchPath(sessionId);
	try {
		mkdirSync(dir, { mode: 0o700 });
		live.add(dir);
		if (!exitHandlerSet) {
			exitHandlerSet = true;
			process.once("exit", removeAllAtExit);
		}
		return dir;
	} catch {
		return null;
	}
}

/**
 * Removes the directory and what is in it, only when lstat shows a real directory (not a
 * symlink) owned by this uid. Never throws; safe to call twice.
 */
export function removeSessionScratch(dir: string | null): void {
	if (!dir) return;
	live.delete(dir);
	try {
		const st = lstatSync(dir);
		if (!st.isDirectory() || st.isSymbolicLink()) return;
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) return;
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best effort: it is under the temp dir
	}
}

/** The prompt block that names the directory. Empty when there is none. */
export function sessionScratchNote(dir: string | null): string {
	if (!dir) return "";
	return `\n\n**Scratch directory: \`${dir}/\`.** Put every scratch, temp or test-output file there. Never create scratch files or directories (tmp/, out/, notes) in the repo. It is removed when the session ends.`;
}
