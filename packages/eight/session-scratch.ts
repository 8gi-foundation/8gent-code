/**
 * The session's scratch directory, outside the repo (#4711).
 *
 * `$TMPDIR/8gent-<session id>/`: created at session start, removed at session end, named in
 * the system prompt so the model keeps scratch files there and not in the person's repo.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sessionScratchPath(sessionId: string): string {
	return join(tmpdir(), `8gent-${sessionId}`);
}

/** Creates the directory (mode 0700). Returns its path, or null when it could not be made. */
export function createSessionScratch(sessionId: string): string | null {
	const dir = sessionScratchPath(sessionId);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	} catch {
		return null;
	}
}

/** Removes the directory and what is in it. Never throws; safe to call twice. */
export function removeSessionScratch(dir: string | null): void {
	if (!dir) return;
	try {
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
