/**
 * Session persistence for headless runs (`8gent -p`, `8gent run`).
 *
 * `RunSessionStore` is the minimal interface the run needs from the session
 * layer: the latest session of a folder (E2, F4), reading it back, and saving.
 * The default implementation sits on the public SessionManager API and filters
 * by folder here. When the session lane (L4) ships its own cwd-scoped
 * "latest" call, swap `defaultRunSessionStore` to delegate to it; nothing
 * else in the run changes.
 */
import * as path from "node:path";
import { SessionManager, type SessionInfo } from "./session-manager";

export interface RunSessionMessage {
	role: string;
	content: string;
}

export interface RunSessionStore {
	/** The most recently active session whose folder is `cwd`, or null. */
	latestForCwd(cwd: string): SessionInfo | null;
	/** One session by exact id, with its messages. */
	load(id: string): (SessionInfo & { messages: RunSessionMessage[] }) | null;
	/** Create or overwrite the session `id`. */
	save(
		id: string,
		messages: RunSessionMessage[],
		meta: { model: string; provider: string; cwd: string },
	): void;
}

const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);

export function defaultRunSessionStore(sessionDir?: string): RunSessionStore {
	const sm = new SessionManager(sessionDir);
	return {
		latestForCwd(cwd) {
			// list() is sorted newest first.
			return sm.list(Number.MAX_SAFE_INTEGER).find((s) => same(s.cwd, cwd)) ?? null;
		},
		load: (id) => sm.get(id),
		save(id, messages, meta) {
			sm.save(id, messages, { ...meta, channel: "run" });
		},
	};
}
