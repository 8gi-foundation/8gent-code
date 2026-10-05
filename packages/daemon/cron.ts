/**
 * Cron - Job scheduler for the daemon.
 *
 * Supports cron expressions, one-shot and recurring jobs,
 * persistence to ~/.8gent/cron.json, and restart catchup.
 */

import { shellInvocation } from "../core/shell";
import { bus } from "./events";

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

const CRON_PATH = `${process.env.HOME}/.8gent/cron.json`;
let jobs: CronJob[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;

export async function loadJobs(): Promise<CronJob[]> {
	try {
		const file = Bun.file(CRON_PATH);
		if (!(await file.exists())) return [];
		jobs = await file.json();
		return jobs;
	} catch {
		jobs = [];
		return jobs;
	}
}

async function saveJobs(): Promise<void> {
	await Bun.write(CRON_PATH, JSON.stringify(jobs, null, 2));
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

/**
 * Run a job's `when` check. Returns "run" or "skip". Anything that stops the
 * check from giving a real answer (spawn failure, exit 126/127, signal,
 * timeout) fails open: the job runs as it would without a check.
 */
async function whenGate(job: CronJob): Promise<"run" | "skip"> {
	const skips = job.skips ?? 0;
	if (job.maxSkips && job.maxSkips > 0 && skips >= job.maxSkips) {
		console.log(`[cron] when: ${job.name} skipped ${skips} times, running anyway`);
		return "run";
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const sh = shellInvocation(job.when as string);
		const proc = Bun.spawn([sh.file, ...sh.args], {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
			windowsVerbatimArguments: sh.windowsVerbatimArguments,
		});
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => {
				proc.kill();
				resolve("timeout");
			}, WHEN_TIMEOUT_MS);
		});
		const code = await Promise.race([proc.exited, timedOut]);
		if (code === 0) return "run";
		if (code === "timeout" || proc.signalCode || code === 126 || code === 127) {
			console.log(`[cron] when: ${job.name} check failed (${code === "timeout" ? "timeout" : `exit ${code}`}), running anyway`);
			return "run";
		}
		console.log(`[cron] when: ${job.name} skipped (exit ${code})`);
		return "skip";
	} catch (err) {
		console.log(`[cron] when: ${job.name} check errored (${String(err)}), running anyway`);
		return "run";
	} finally {
		clearTimeout(timer);
	}
}

async function executeJob(job: CronJob): Promise<void> {
	if (process.env.EIGHT_CRON_WHEN === "1" && job.type === "agent-prompt" && job.when) {
		if ((await whenGate(job)) === "skip") {
			job.skips = (job.skips ?? 0) + 1;
			await saveJobs();
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
		bus.emit("agent:error", { sessionId: "cron", error: String(err) });
	}

	job.lastRun = new Date().toISOString();
	if (!job.recurring) job.enabled = false;
	await saveJobs();
}

function tick(): void {
	const now = new Date();
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

export async function startCron(): Promise<void> {
	await loadJobs();
	await catchup();
	// Tick every 60 seconds
	tickTimer = setInterval(tick, 60_000);
}

export function stopCron(): void {
	if (tickTimer) {
		clearInterval(tickTimer);
		tickTimer = null;
	}
}

export function addJob(job: CronJob): void {
	jobs.push(job);
	saveJobs().catch(console.error);
}

export function removeJob(id: string): boolean {
	const idx = jobs.findIndex((j) => j.id === id);
	if (idx === -1) return false;
	jobs.splice(idx, 1);
	saveJobs().catch(console.error);
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
