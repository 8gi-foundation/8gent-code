/**
 * Session persistence for headless runs (`8gent -p`, `8gent run`).
 *
 * `RunSessionStore` is the minimal interface the run needs from the session
 * layer: the latest session of a folder (E2, F4), reading it back, and saving.
 * The default implementation is the JSONL tree store (session-store.ts), the
 * one store every surface writes to (row E1): `--continue` resumes what the
 * TUI or an earlier `-p` run saved in this folder, and a headless run's
 * session shows up in the TUI's picker. SessionManager is the tree store's
 * read/write facade (it also migrates pre-tree .json files on first touch).
 */
import { SessionManager } from "./session-manager";
import { type SessionListItem, latestSessionForCwd } from "./session-store";

export interface RunSessionMessage {
	role: string;
	content: string;
}

/** What the run needs to know about a stored session. */
export type RunSessionSummary = Pick<
	SessionListItem,
	"id" | "name" | "model" | "provider" | "cwd" | "messageCount"
>;

export interface RunSessionStore {
	/** The most recently active non-empty session whose folder is `cwd`, or null. */
	latestForCwd(cwd: string): RunSessionSummary | null;
	/** One session by exact id, with its messages. */
	load(id: string): (RunSessionSummary & { messages: RunSessionMessage[] }) | null;
	/** Create or overwrite the session `id`. */
	save(
		id: string,
		messages: RunSessionMessage[],
		meta: { model: string; provider: string; cwd: string },
	): void;
}

export function defaultRunSessionStore(sessionDir?: string): RunSessionStore {
	const sm = new SessionManager(sessionDir);
	return {
		// Folder match and "newest with a message" live in the store, so the
		// run, the TUI and the picker all mean the same thing by "latest".
		latestForCwd: (cwd) => latestSessionForCwd(cwd, sessionDir),
		load: (id) => sm.get(id),
		save(id, messages, meta) {
			sm.save(id, messages, { ...meta, channel: "run" });
		},
	};
}
