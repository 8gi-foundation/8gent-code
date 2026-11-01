/**
 * Loop job files (#5073, slice 2 of #5067).
 *
 * One tiny writer any loop calls to say what it is doing. Each loop owns one
 * file, ~/.8gent/jobs/<name>.json, which the Control tab reads. No deps, local
 * disk only, atomic (tmp file then rename), and event-driven: a file is written
 * when a loop starts, changes state or finishes, never on a timer.
 *
 * Reporting is best effort. It never throws, so a full disk or a read-only home
 * cannot stop the loop that is reporting.
 *
 * The folder is, in order: EIGHT_JOBS_DIR, then $HOME/.8gent/jobs (the folder
 * the reader watches). Under `bun test` (NODE_ENV=test) nothing is written
 * unless EIGHT_JOBS_DIR is set, so a test run never touches the owner's folder.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type JobState = "waiting-on-you" | "running" | "queued" | "stalled" | "done";

export interface JobReport {
	kind: string;
	name: string;
	state: JobState;
	stage?: string;
	/** ISO time or free text. A number is read as epoch milliseconds. */
	last?: string | number | null;
	next?: string | number | null;
	waitingOn?: string | null;
	detail?: string;
}

export function jobsDir(env: Record<string, string | undefined> = process.env): string | null {
	if (env.EIGHT_JOBS_DIR) return env.EIGHT_JOBS_DIR;
	if (env.NODE_ENV === "test") return null;
	return path.join(env.HOME || os.homedir(), ".8gent", "jobs");
}

/** A file name from a loop name: letters, digits, dot, dash and underscore only. */
export function jobFileName(name: string): string {
	const safe = name
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+/, "")
		.slice(0, 80);
	return `${safe || "loop"}.json`;
}

/** Write one job file atomically. Returns true when it landed. Never throws. */
export function writeJobFile(job: JobReport, dir: string | null = jobsDir()): boolean {
	if (!dir) return false;
	try {
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, jobFileName(job.name));
		const body = {
			kind: job.kind,
			name: job.name,
			state: job.state,
			stage: job.stage ?? "",
			last: job.last ?? null,
			next: job.next ?? null,
			waitingOn: job.waitingOn ?? null,
			detail: job.detail ?? "",
		};
		// Exclusive create under an unpredictable name: a planted symlink is never followed.
		const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			fs.renameSync(tmp, file);
		} catch (err) {
			try {
				fs.unlinkSync(tmp);
			} catch {}
			throw err;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Drop finished helper-run files older than `maxAgeMs`, so one file per
 * short-lived run does not pile up. Only files 8gent's helper runs wrote are
 * touched: named `helper-*.json`, kind `helper`, state `done`. An owner's own
 * files and the cron and update rows are never removed. Call it on an event.
 */
export function pruneDoneJobs(
	maxAgeMs: number,
	dir: string | null = jobsDir(),
	now: number = Date.now(),
): number {
	if (!dir) return 0;
	let removed = 0;
	try {
		for (const f of fs.readdirSync(dir)) {
			if (!f.startsWith("helper-") || !f.endsWith(".json")) continue;
			const full = path.join(dir, f);
			try {
				if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;
				const o = JSON.parse(fs.readFileSync(full, "utf8"));
				if (o && o.state === "done" && o.kind === "helper") {
					fs.unlinkSync(full);
					removed += 1;
				}
			} catch {}
		}
	} catch {}
	return removed;
}
