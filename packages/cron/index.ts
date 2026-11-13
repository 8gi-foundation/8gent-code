/**
 * @8gent/cron - Lightweight cron job scheduler
 *
 * Parses basic cron expressions (minute hour day month weekday)
 * and runs 8gent commands via Bun.spawn when due.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { eightCliPath, safeBunFlags } from "../core/bun-flags";
import { shellInvocation } from "../core/shell";
import { dataDirPath } from "../daemon/data-dir";

/**
 * The one row shape in cron.json, shared with the daemon scheduler (packages/daemon/cron.ts, #255).
 * `schedule` and `command` are read-only aliases of `expression` and `payload` for callers that
 * predate the shared shape; they are never written to disk.
 */
export type CronJobType = "shell" | "agent-prompt" | "webhook";

export interface CronRow {
	id: string;
	name: string;
	expression: string; // cron expression, or "once:ISO8601"
	type: CronJobType;
	payload: string; // shell command, prompt text, or webhook URL
	enabled: boolean;
	lastRun: string | null;
	nextRun: string | null;
	recurring: boolean;
	/** Run once when a scheduled slot was missed (default true). Set false to opt out. */
	catchUp?: boolean;
	[extra: string]: unknown;
}

export interface CronJob extends CronRow {
	schedule: string;
	command: string;
}

const JOB_TYPES: CronJobType[] = ["shell", "agent-prompt", "webhook"];

function validExpression(expr: unknown): expr is string {
	if (typeof expr !== "string") return false;
	if (expr.startsWith("once:")) return !Number.isNaN(new Date(expr.slice(5)).getTime());
	return expr.trim().split(/\s+/).length === 5;
}

/** Shell line that runs an 8gent subcommand, for rows written in the old `command` shape. */
function eightShellLine(command: string): string {
	const cli = eightCliPath();
	return cli ? `bun ${safeBunFlags().join(" ")} run "${cli}" ${command}`.replace(/\s+/g, " ") : `8gent ${command}`;
}

/**
 * Read one cron.json row in either shape (daemon shape, or the old CLI shape with
 * `schedule`/`command`) into the shared shape. Returns null for a row that cannot be run.
 */
export function normalizeCronRow(raw: unknown): CronRow | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id) return null;
	const legacy = r.expression === undefined && r.payload === undefined;
	const expression = r.expression ?? r.schedule;
	if (!validExpression(expression)) return null;
	const body = r.payload ?? r.command;
	if (typeof body !== "string" || !body.trim()) return null;
	if (r.type !== undefined && !JOB_TYPES.includes(r.type as CronJobType)) return null;
	const { schedule: _s, command: _c, ...rest } = r;
	return {
		...rest,
		id: r.id,
		name: typeof r.name === "string" && r.name ? r.name : r.id,
		expression,
		type: (r.type as CronJobType | undefined) ?? "shell",
		payload: legacy ? eightShellLine(body) : body,
		enabled: r.enabled !== false,
		lastRun: typeof r.lastRun === "string" ? r.lastRun : null,
		nextRun: typeof r.nextRun === "string" ? r.nextRun : null,
		recurring: r.recurring !== false,
	};
}

/** Parse cron.json text. `rows` are runnable; `rejected` are kept verbatim so a rewrite never drops them. */
export function parseCronFile(text: string): { rows: CronRow[]; rejected: unknown[] } {
	const rows: CronRow[] = [];
	const rejected: unknown[] = [];
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { rows, rejected };
	}
	if (!Array.isArray(data)) return { rows, rejected };
	for (const raw of data) {
		const row = normalizeCronRow(raw);
		if (row) rows.push(row);
		else {
			rejected.push(raw);
			const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
			console.log(`[cron] skipping unreadable row${typeof id === "string" ? ` ${id}` : ""}`);
		}
	}
	return { rows, rejected };
}

function withAliases(row: CronRow): CronJob {
	return { ...row, schedule: row.expression, command: row.payload };
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
	private jobs: CronRow[];
	private rejected: unknown[] = [];

	constructor(dataPath?: string) {
		this.filePath = dataPath || path.join(dataDirPath(), "cron.json");
		this.jobs = this.load();
	}

	private load(): CronRow[] {
		try {
			if (fs.existsSync(this.filePath)) {
				const { rows, rejected } = parseCronFile(fs.readFileSync(this.filePath, "utf-8"));
				this.rejected = rejected;
				return rows;
			}
		} catch {
			// unreadable file - start fresh
		}
		return [];
	}

	private save(): void {
		const dir = path.dirname(this.filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.filePath, JSON.stringify([...this.jobs, ...this.rejected], null, 2));
	}

	/**
	 * Add a job. `schedule`/`command` are the CLI names for `expression`/`payload`.
	 * With the default type "shell" the command is an 8gent subcommand and is wrapped
	 * into a shell line; other types store the command as given.
	 */
	add(job: {
		name: string;
		schedule: string;
		command: string;
		enabled: boolean;
		type?: CronJobType;
		lastRun?: string;
		catchUp?: boolean;
	}): CronJob {
		const type = job.type ?? "shell";
		const entry: CronRow = {
			id: crypto.randomUUID().slice(0, 8),
			name: job.name,
			expression: job.schedule,
			type,
			payload: type === "shell" ? eightShellLine(job.command) : job.command,
			enabled: job.enabled,
			lastRun: job.lastRun ?? null,
			nextRun: null,
			recurring: !job.schedule.startsWith("once:"),
		};
		if (job.catchUp !== undefined) entry.catchUp = job.catchUp;
		this.jobs.push(entry);
		this.save();
		return withAliases(entry);
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
		return this.jobs.map(withAliases);
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
			if (!job.enabled || job.type !== "shell") continue;
			const lastRun = job.catchUp === false ? undefined : (job.lastRun ?? undefined);
			if (!dueSince(job.expression, lastRun, now)) continue;
			if (!cronMatches(job.expression, now)) {
				console.log(
					`[cron] catch-up: job ${job.id} "${job.name}" missed its slot since ${job.lastRun}, running once`,
				);
			}
			job.lastRun = now.toISOString();
			try {
				const sh = shellInvocation(job.payload);
				Bun.spawn([sh.file, ...sh.args], { stdout: "ignore", stderr: "ignore" });
			} catch {
				// spawn failure is non-fatal
			}
		}
		this.save();
	}
}
