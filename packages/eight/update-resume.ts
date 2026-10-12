/**
 * Resume after `/update` (TUI). The TUI cannot replace itself, so it saves the
 * session, records what to resume in <home>/.8gent/update-resume.json, and
 * exits with RELAUNCH_EXIT_CODE. The `8gent` launcher that spawned it sees
 * that code, reads the record, and starts a fresh 8gent (the new code) with
 * `--resume=<session id>`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../core/home";

export const RELAUNCH_EXIT_CODE = 75;
/** Env var the relaunched 8gent reads to show its one-line note. */
export const UPDATE_NOTE_ENV = "EIGHT_UPDATE_NOTE";

export interface ResumeRequest {
	sessionId?: string;
	note: string;
}

type Env = Record<string, string | undefined>;

export function dataDir(env: Env = process.env): string {
	return join(resolveHome(env), ".8gent");
}

const file = (env: Env) => join(dataDir(env), "update-resume.json");

export function writeResumeRequest(req: ResumeRequest, env: Env = process.env): void {
	mkdirSync(dataDir(env), { recursive: true });
	writeFileSync(file(env), JSON.stringify(req), "utf8");
}

/** Read and delete the record; null when absent or unreadable. A session id must look like an id. */
export function consumeResumeRequest(env: Env = process.env): ResumeRequest | null {
	const f = file(env);
	try {
		const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<ResumeRequest>;
		rmSync(f, { force: true });
		const id =
			typeof raw.sessionId === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(raw.sessionId)
				? raw.sessionId
				: undefined;
		return {
			sessionId: id,
			note: typeof raw.note === "string" ? raw.note.slice(0, 200) : "Updated.",
		};
	} catch {
		try {
			rmSync(f, { force: true });
		} catch {}
		return null;
	}
}

/**
 * The command that starts the new 8gent. A compiled binary re-runs itself;
 * otherwise the same runtime runs the same entry script (now the new code).
 */
export function relaunchCommand(o: {
	embedded: boolean;
	execPath: string;
	entryScript?: string;
	req: ResumeRequest;
	env?: Env;
}): { command: string; args: string[]; env: Env } {
	const resume = o.req.sessionId ? [`--resume=${o.req.sessionId}`] : [];
	const args = o.embedded || !o.entryScript ? resume : [o.entryScript, ...resume];
	return {
		command: o.execPath,
		args,
		env: { ...(o.env ?? process.env), [UPDATE_NOTE_ENV]: o.req.note },
	};
}
