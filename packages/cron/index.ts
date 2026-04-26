/**
 * @8gent/cron - Lightweight cron job scheduler
 *
 * Parses basic cron expressions (minute hour day month weekday)
 * and runs 8gent commands via Bun.spawn when due.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface CronJob {
	id: string;
	name: string;
	schedule: string; // cron expression e.g. "0 */6 * * *"
	command: string; // 8gent command to run e.g. "chat 'check deploy status'"
	enabled: boolean;
	lastRun?: string;
	nextRun?: string;
}

function matchField(field: string, value: number, max: number): boolean {
	if (field === "*") return true;
	// */N step
	if (field.startsWith("*/")) {
		const step = parseInt(field.slice(2), 10);
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
	return parseInt(field, 10) === value;
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
	tick(): void {
		const now = new Date();
		for (const job of this.jobs) {
			if (!job.enabled) continue;
			if (!cronMatches(job.schedule, now)) continue;
			job.lastRun = now.toISOString();
			// Fire and forget - spawn 8gent with the job's command
			const args = job.command.split(/\s+/);
			try {
				Bun.spawn(["bun", "run", "bin/8gent.ts", ...args], {
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
