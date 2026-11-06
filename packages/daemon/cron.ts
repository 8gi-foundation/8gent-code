/**
 * Cron - Job scheduler for the daemon.
 *
 * Supports cron expressions, one-shot and recurring jobs,
 * persistence to ~/.8gent/cron.json, and restart catchup.
 */

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJobFile } from "../core/job-file";
import { killProcessTree, shellInvocation, spawnShell } from "../core/shell";
import { getDataDir } from "./data-dir";
import { bus } from "./events";
import { tickRoutines } from "./routines-tick";

export type JobType = "shell" | "agent-prompt" | "webhook";

export interface CronJob {
	id: string;
	name: string;
	expression: string; // cron expression: "*/30 * * * *" or "once:ISO8601"
	type: JobType;
	payload: string; // shell command, prompt text, or webhook URL
	enabled: boolean;
	lastRun: string | null;
	nextRun: string | null;
	recurring: boolean;
	/** agent-prompt only, EIGHT_CRON_WHEN=1: shell check run before queuing; exit 0 queues, other exits skip. */
	when?: string;
	/** After this many consecutive skips the job runs without checking. */
	maxSkips?: number;
	/** Consecutive skips so far (written by the gate). */
	skips?: number;
}

/** cron.json under the data dir (EIGHT_DATA_DIR, then os.homedir()/.8gent; #4111). */
export function cronPath(): string {
	return join(getDataDir(), "cron.json");
}

let jobs: CronJob[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;

export async function loadJobs(): Promise<CronJob[]> {
	try {
		const file = Bun.file(cronPath());
		if (!(await file.exists())) return [];
		jobs = await file.json();
		return jobs;
	} catch {
		jobs = [];
		return jobs;
	}
}

let saveChain: Promise<void> = Promise.resolve();

/**
 * Read cron.json fresh, apply one change, write it back atomically. Two daemons (or a daemon and a hand edit)
 * share this file, so a save must never write the whole in-memory list over what the other side added.
 * Saves in this process are serialised so two jobs finishing together cannot interleave read and write.
 */
function persist(apply: (disk: CronJob[]) => CronJob[]): Promise<void> {
	const next = saveChain.then(async () => {
		let disk: CronJob[] = jobs;
		try {
			const f = Bun.file(cronPath());
			if (await f.exists()) disk = await f.json();
		} catch {
			// Unreadable file: keep what we hold rather than overwrite with a guess.
		}
		jobs = apply(disk);
		const tmp = `${cronPath()}.${process.pid}.tmp`;
		await Bun.write(tmp, JSON.stringify(jobs, null, 2));
		renameSync(tmp, cronPath());
	});
	// A failed save is logged and ends there: the chain continues from a settled promise, so one bad save
	// (disk full, a non-list cron.json) cannot stop every later save until restart (8SO on #27).
	saveChain = next.catch((err) => console.error("[cron] save failed:", err));
	return saveChain;
}

/**
 * Re-read cron.json for the runner. A job removed or disabled by another process or a hand edit stops on the
 * next tick (8SO on #27). An unreadable or non-list file keeps the jobs already held, so a half-written file
 * never silently stops every job; a missing file means no jobs.
 */
async function reloadForTick(): Promise<void> {
	try {
		const f = Bun.file(cronPath());
		if (!(await f.exists())) {
			jobs = [];
			return;
		}
		const disk = await f.json();
		if (Array.isArray(disk)) jobs = disk;
		else console.error("[cron] cron.json is not a list; keeping the jobs already loaded");
	} catch (err) {
		console.error("[cron] cron.json unreadable; keeping the jobs already loaded:", err);
	}
}

/** Write one job's run state onto the on-disk copy of that job; a job removed meanwhile stays removed. */
function saveRun(job: CronJob): Promise<void> {
	return persist((disk) =>
		disk.map((j) =>
			j.id === job.id
				? {
						...j,
						lastRun: job.lastRun,
						enabled: job.enabled,
						skips: job.skips,
						nextRun: job.nextRun,
					}
				: j,
		),
	);
}

/** Only one process per data dir ticks cron. The lock holds the pid and a heartbeat; 3 minutes silent is stale. */
export const RUNNER_STALE_MS = 180_000;
let isRunner = false;

export function runnerLockPath(): string {
	return join(getDataDir(), "cron.runner.lock");
}

/** Take the runner lock, or refresh it if it is already ours. False when a live process holds it. */
export function acquireRunner(now = Date.now(), pid = process.pid): boolean {
	const p = runnerLockPath();
	const body = () => JSON.stringify({ pid, heartbeat: now });
	try {
		mkdirSync(dirname(p), { recursive: true });
	} catch {
		return false;
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(p, body(), { flag: "wx" });
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		let heartbeat = 0;
		let holder = -1;
		try {
			const held = JSON.parse(readFileSync(p, "utf8"));
			holder = held.pid;
			heartbeat = Number(held.heartbeat) || 0;
		} catch {
			try {
				heartbeat = statSync(p).mtimeMs; // half-written or garbled: judge by file age
			} catch {
				continue; // vanished, try the create again
			}
		}
		if (holder === pid) {
			writeFileSync(p, body());
			return true;
		}
		if (now - heartbeat < RUNNER_STALE_MS) return false;
		try {
			unlinkSync(p); // stale: take over. A lost race here corrects itself, see the heartbeat check.
		} catch {}
	}
	return false;
}

/** Give the lock up on a clean stop, only if it is ours. */
export function releaseRunner(pid = process.pid): void {
	try {
		if (JSON.parse(readFileSync(runnerLockPath(), "utf8")).pid === pid)
			unlinkSync(runnerLockPath());
	} catch {}
	isRunner = false;
}

/** Parse a simple cron expression and check if it matches the current minute */
function matchesCron(expr: string, now: Date): boolean {
	if (expr.startsWith("once:")) {
		const target = new Date(expr.slice(5));
		return Math.abs(now.getTime() - target.getTime()) < 60_000;
	}

	const parts = expr.split(/\s+/);
	if (parts.length !== 5) return false;

	const fields = [
		now.getMinutes(),
		now.getHours(),
		now.getDate(),
		now.getMonth() + 1,
		now.getDay(),
	];

	return parts.every((part, i) => {
		if (part === "*") return true;
		if (part.startsWith("*/")) {
			const step = Number.parseInt(part.slice(2), 10);
			return fields[i] % step === 0;
		}
		const vals = part.split(",").map(Number);
		return vals.includes(fields[i]);
	});
}

const WHEN_TIMEOUT_MS = 5_000;
const WHEN_KILL_GRACE_MS = 500;

type WhenExit = { code: number | null; signal: string | null } | "timeout" | "error";

/**
 * Run a job's `when` check. Returns "run" or "skip". Anything that stops the
 * check from giving a real answer (spawn failure, exit 126/127, signal,
 * timeout) fails open: the job runs as it would without a check. The check
 * runs in its own process group, which is always killed before returning, so
 * background or TERM-trapping children cannot outlive it.
 */
async function whenGate(job: CronJob): Promise<"run" | "skip"> {
	const skips = job.skips ?? 0;
	if (job.maxSkips && job.maxSkips > 0 && skips >= job.maxSkips) {
		console.log(`[cron] when: ${job.name} skipped ${skips} times, running anyway`);
		return "run";
	}
	const command = job.when as string;
	bus.emit("tool:start", { sessionId: "cron", tool: "cron:when", input: command });
	const startMs = Date.now();
	let result: WhenExit = "error";
	let pid: number | undefined;
	try {
		const child = spawnShell(command, { stdio: "ignore", processGroup: true });
		pid = child.pid;
		const exited = new Promise<WhenExit>((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
			child.once("error", () => resolve("error"));
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((r) => {
			timer = setTimeout(() => r("timeout"), WHEN_TIMEOUT_MS);
		});
		result = await Promise.race([exited, timedOut]);
		clearTimeout(timer);
		if (result === "timeout") {
			killProcessTree(pid, "SIGTERM");
			await Promise.race([exited, Bun.sleep(WHEN_KILL_GRACE_MS)]);
		}
	} catch {
		result = "error";
	} finally {
		killProcessTree(pid, "SIGKILL");
	}
	const exitCode = typeof result === "object" ? result.code : null;
	const failed =
		typeof result !== "object" || result.signal !== null || exitCode === 126 || exitCode === 127;
	const outcome = exitCode === 0 ? "run" : failed ? "failed-open" : "skip";
	bus.emit("tool:result", {
		sessionId: "cron",
		tool: "cron:when",
		output: { command, exitCode, outcome },
		durationMs: Date.now() - startMs,
	});
	if (outcome === "failed-open") {
		const why =
			typeof result === "string"
				? result
				: result.signal
					? `signal ${result.signal}`
					: `exit ${exitCode}`;
		console.log(`[cron] when: ${job.name} check failed (${why}), running anyway`);
	}
	return outcome === "skip" ? "skip" : "run";
}

async function executeJob(job: CronJob): Promise<void> {
	if (process.env.EIGHT_CRON_WHEN === "1" && job.type === "agent-prompt" && job.when) {
		if ((await whenGate(job)) === "skip") {
			job.skips = (job.skips ?? 0) + 1;
			console.log(`[cron] when: ${job.name} skipped (${job.skips} in a row)`);
			if (!job.recurring) {
				job.enabled = false;
				console.log(`[cron] when: ${job.name} is a one-shot, skip consumed it, will not run`);
			}
			await saveRun(job);
			return;
		}
		job.skips = 0;
	}
	console.log(`[cron] executing job: ${job.name} (${job.type})`);
	bus.emit("tool:start", {
		sessionId: "cron",
		tool: `cron:${job.type}`,
		input: job.payload,
	});

	const startMs = Date.now();
	let failure: string | null = null;
	reportCron(job, "running", { last: job.lastRun });
	try {
		let output: unknown;
		if (job.type === "shell") {
			const sh = shellInvocation(job.payload);
			const proc = Bun.spawn([sh.file, ...sh.args], {
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				windowsVerbatimArguments: sh.windowsVerbatimArguments,
			});
			output = await new Response(proc.stdout).text();
			// A non-zero exit is a failure someone must act on: say so on the bus (#4868).
			const code = await proc.exited;
			if (code !== 0) failure = `exited ${code}`;
			if (code !== 0)
				bus.emit("agent:error", {
					sessionId: "cron",
					error: `cron job ${job.name} exited ${code}`,
				});
		} else if (job.type === "webhook") {
			const res = await fetch(job.payload, { method: "POST" });
			output = { status: res.status };
		} else {
			// agent-prompt: emit an event for the agent loop to pick up
			output = { prompt: job.payload, queued: true };
		}

		bus.emit("tool:result", {
			sessionId: "cron",
			tool: `cron:${job.type}`,
			output,
			durationMs: Date.now() - startMs,
		});
	} catch (err) {
		failure = String(err).slice(0, 120);
		bus.emit("agent:error", { sessionId: "cron", error: String(err) });
	}

	job.lastRun = new Date().toISOString();
	if (!job.recurring) job.enabled = false;
	await saveRun(job);
	// A failed run stays visible until someone looks; a clean one moves to done.
	if (failure) {
		reportCron(job, "waiting-on-you", {
			last: job.lastRun,
			waitingOn: `check ${job.name}: ${failure}`,
			stage: "failed",
		});
	} else {
		reportCron(job, "done", { last: job.lastRun, stage: "finished" });
	}
}

/** One Control-tab row per durable job (#5073). Written on start, on a failure, on finish. */
function reportCron(
	job: CronJob,
	state: "running" | "done" | "waiting-on-you",
	more: { last?: string | null; waitingOn?: string; stage?: string },
): void {
	writeJobFile({
		kind: "cron",
		name: `cron-${job.name}`,
		state,
		stage: more.stage ?? (state === "running" ? job.type : ""),
		last: more.last ?? null,
		next: job.nextRun,
		waitingOn: more.waitingOn ?? null,
		detail: "",
	});
}

async function tick(): Promise<void> {
	const was = isRunner;
	isRunner = acquireRunner();
	if (!isRunner) {
		if (was) console.log("[cron] lost the runner lock, standing by");
		return;
	}
	if (!was) console.log("[cron] took the runner lock");
	await reloadForTick(); // every tick, not only on takeover: another process may have changed the jobs
	const now = new Date();
	// Saved routines (scouts by default): RoutineManager.tick had no caller before #4926.
	void tickRoutines({ now });
	for (const job of jobs) {
		if (!job.enabled) continue;
		if (matchesCron(job.expression, now)) {
			executeJob(job).catch((err) => console.error("[cron] tick error:", err));
		}
	}
}

/** Check for missed jobs since last run and execute them */
async function catchup(): Promise<void> {
	const now = new Date();
	for (const job of jobs) {
		if (!job.enabled || !job.lastRun) continue;
		const lastRun = new Date(job.lastRun);
		const gapMinutes = (now.getTime() - lastRun.getTime()) / 60_000;
		// If more than 2 intervals were missed, run once to catch up
		if (job.expression.startsWith("*/")) {
			const step = Number.parseInt(job.expression.split("*/")[1], 10);
			if (gapMinutes > step * 2) {
				console.log(`[cron] catchup: running missed job ${job.name}`);
				await executeJob(job);
			}
		}
	}
}

/** One runner tick, exported for tests. */
export const cronTick = (): Promise<void> => tick();

export async function startCron(): Promise<void> {
	await loadJobs();
	isRunner = acquireRunner();
	if (isRunner) await catchup();
	else console.log("[cron] another process holds the runner lock, standing by");
	// Tick every 60 seconds; a standby process retakes the lock if the runner goes quiet for 3 minutes
	tickTimer = setInterval(() => void tick(), 60_000);
}

export function stopCron(): void {
	if (tickTimer) {
		clearInterval(tickTimer);
		tickTimer = null;
	}
	releaseRunner();
}

export function addJob(job: CronJob): void {
	jobs.push(job);
	void persist((disk) => (disk.some((j) => j.id === job.id) ? disk : [...disk, job]));
}

export function removeJob(id: string): boolean {
	const idx = jobs.findIndex((j) => j.id === id);
	if (idx === -1) return false;
	jobs.splice(idx, 1);
	void persist((disk) => disk.filter((j) => j.id !== id));
	return true;
}

export function getJobs(): CronJob[] {
	return [...jobs];
}

/** Return the next job that is due (used by heartbeat) */
export function getNextDueJob(): CronJob | null {
	const now = new Date();
	for (const job of jobs) {
		if (!job.enabled) continue;
		if (matchesCron(job.expression, now)) return job;
	}
	return null;
}
