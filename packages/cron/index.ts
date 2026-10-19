/**
 * @8gent/cron - Lightweight cron job scheduler
 *
 * Parses basic cron expressions (minute hour day month weekday)
 * and runs 8gent commands via Bun.spawn when due.
 */

import { eightCliPath, safeBunFlags } from "../core/bun-flags";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CronJob {
	id: string;
	name: string;
	schedule: string; // cron expression e.g. "0 */6 * * *"
	command: string; // 8gent command to run e.g. "chat 'check deploy status'"
	enabled: boolean;
	lastRun?: string;
	nextRun?: string;
	/** Run once when a scheduled slot was missed (default true). Set false to opt out. */
	catchUp?: boolean;
}

function matchField(field: string, value: number, max: number): boolean {
	if (field === "*") return true;
	// */N step
	if (field.startsWith("*/")) {
		const step = Number.parseInt(field.slice(2), 10);
		return step > 0 && value % step === 0;
	}
	// range: 1-5
	if (field.includes("-")) {
		const [lo, hi] = field.split("-").map(Number);
		return value >= lo && value <= hi;
	}
	// comma list: 1,3,5
	if (field.includes(",")) {
		return field.split(",").map(Number).includes(value);
	}
	// exact value
	return Number.parseInt(field, 10) === value;
}

/** Returns true if the cron expression matches the given Date */
export function cronMatches(expression: string, date: Date): boolean {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const [min, hour, day, month, weekday] = parts;
	return (
		matchField(min, date.getMinutes(), 59) &&
		matchField(hour, date.getHours(), 23) &&
		matchField(day, date.getDate(), 31) &&
		matchField(month, date.getMonth() + 1, 12) &&
		matchField(weekday, date.getDay(), 6)
	);
}

/** Catch-up looks back at most this far, so a long outage never replays old work. */
export const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

/**
 * True if `schedule` had a slot in the minutes after `lastRun` up to and including
 * the minute of `now` (capped at 24 h). Without a `lastRun` only the exact minute counts.
 * Any number of missed slots is still one boolean, so the caller fires once.
 */
export function dueSince(schedule: string, lastRun: Date | string | undefined, now: Date): boolean {
	const nowMin = Math.floor(now.getTime() / MINUTE_MS);
	const last = lastRun === undefined ? Number.NaN : new Date(lastRun).getTime();
	const lastMin = Number.isNaN(last) ? nowMin - 1 : Math.floor(last / MINUTE_MS);
	const floorMin = Math.max(lastMin, nowMin - CATCHUP_WINDOW_MS / MINUTE_MS);
	for (let m = nowMin; m > floorMin; m--) {
		if (cronMatches(schedule, new Date(m * MINUTE_MS))) return true;
	}
	return false;
}

export class CronManager {
	private filePath: string;
	private jobs: CronJob[];

	constructor(dataPath?: string) {
		const home = process.env.HOME || process.env.USERPROFILE || "~";
		this.filePath = dataPath || path.join(home, ".8gent", "cron.json");
		this.jobs = this.load();
	}

	private load(): CronJob[] {
		try {
			if (fs.existsSync(this.filePath)) {
				return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
			}
		} catch {
			// corrupted file - start fresh
		}
		return [];
	}

	private save(): void {
		const dir = path.dirname(this.filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.filePath, JSON.stringify(this.jobs, null, 2));
	}

	add(job: Omit<CronJob, "id">): CronJob {
		const entry: CronJob = { ...job, id: crypto.randomUUID().slice(0, 8) };
		this.jobs.push(entry);
		this.save();
		return entry;
	}

	remove(id: string): boolean {
		const before = this.jobs.length;
		this.jobs = this.jobs.filter((j) => j.id !== id);
		if (this.jobs.length < before) {
			this.save();
			return true;
		}
		return false;
	}

	list(): CronJob[] {
		return [...this.jobs];
	}

	enable(id: string): void {
		const job = this.jobs.find((j) => j.id === id);
		if (job) {
			job.enabled = true;
			this.save();
		}
	}

	disable(id: string): void {
		const job = this.jobs.find((j) => j.id === id);
		if (job) {
			job.enabled = false;
			this.save();
		}
	}

	/** Check all enabled jobs and run any that are due. Call every minute. */
	tick(now: Date = new Date()): void {
		for (const job of this.jobs) {
			if (!job.enabled) continue;
			const lastRun = job.catchUp === false ? undefined : job.lastRun;
			if (!dueSince(job.schedule, lastRun, now)) continue;
			if (!cronMatches(job.schedule, now)) {
				console.log(`[cron] catch-up: job ${job.id} "${job.name}" missed its slot since ${job.lastRun}, running once`);
			}
			job.lastRun = now.toISOString();
			// Fire and forget - spawn 8gent with the job's command
			const args = job.command.split(/\s+/);
			// The daemon runs in $HOME: 8gent's own CLI by absolute path, no cwd bunfig.toml or .env (#4013).
			const cli = eightCliPath();
			if (!cli) continue;
			try {
				Bun.spawn(["bun", ...safeBunFlags(), "run", cli, ...args], {
					stdout: "ignore",
					stderr: "ignore",
				});
			} catch {
				// spawn failure is non-fatal
			}
		}
		this.save();
	}
}
