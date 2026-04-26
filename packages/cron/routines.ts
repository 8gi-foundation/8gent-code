/**
 * Routines - Named, scheduled agent tasks with prompt bundles
 *
 * A routine combines:
 * - A prompt (what the agent should do)
 * - A schedule (when to run - cron expression)
 * - A repo/cwd (where to run)
 * - Optional triggers (webhook, API, GitHub events)
 * - Run history
 *
 * Routines are stored in ~/.8gent/routines.json and executed by the
 * daemon's cron tick loop. Each run spawns a headless agent session.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cronMatches } from "./index";

// ── Types ───────────────────────────────────────────────────────

export interface Routine {
	id: string;
	name: string;
	description?: string;

	/** The prompt/task for the agent to execute */
	prompt: string;

	/** Cron schedule (e.g. "0 9 * * 1-5" for weekday 9am) */
	schedule: string;

	/** Working directory for the agent */
	cwd?: string;

	/** Model to use (default: agent default) */
	model?: string;

	/** Maximum execution time in seconds (default: 300) */
	timeoutSeconds?: number;

	/** Whether this routine is active */
	enabled: boolean;

	/** Triggers that can fire this routine outside the schedule */
	triggers?: RoutineTrigger[];

	/** Run history (last 10 runs kept) */
	history?: RoutineRun[];

	createdAt: string;
	updatedAt: string;
}

export interface RoutineTrigger {
	type: "webhook" | "github" | "api";
	/** For webhook: path suffix. For github: event type (push, pull_request, etc.) */
	event?: string;
	/** Optional filter (e.g. branch name for github push) */
	filter?: string;
}

export interface RoutineRun {
	id: string;
	startedAt: string;
	completedAt?: string;
	status: "running" | "completed" | "failed" | "timeout";
	trigger: "schedule" | "webhook" | "api" | "manual";
	output?: string;
	error?: string;
}

// ── Manager ─────────────────────────────────────────────────────

export class RoutineManager {
	private filePath: string;
	private routines: Routine[];

	constructor(dataPath?: string) {
		const home = process.env.HOME || process.env.USERPROFILE || "~";
		this.filePath = dataPath || path.join(home, ".8gent", "routines.json");
		this.routines = this.load();
	}

	private load(): Routine[] {
		try {
			if (fs.existsSync(this.filePath)) {
				return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
			}
		} catch {
			// corrupted - start fresh
		}
		return [];
	}

	private save(): void {
		const dir = path.dirname(this.filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.filePath, JSON.stringify(this.routines, null, 2));
	}

	/** Create a new routine */
	create(opts: {
		name: string;
		prompt: string;
		schedule: string;
		description?: string;
		cwd?: string;
		model?: string;
		timeoutSeconds?: number;
		triggers?: RoutineTrigger[];
	}): Routine {
		const now = new Date().toISOString();
		const routine: Routine = {
			id: crypto.randomUUID().slice(0, 8),
			name: opts.name,
			description: opts.description,
			prompt: opts.prompt,
			schedule: opts.schedule,
			cwd: opts.cwd,
			model: opts.model,
			timeoutSeconds: opts.timeoutSeconds || 300,
			enabled: true,
			triggers: opts.triggers,
			history: [],
			createdAt: now,
			updatedAt: now,
		};
		this.routines.push(routine);
		this.save();
		return routine;
	}

	/** Delete a routine by ID */
	delete(id: string): boolean {
		const before = this.routines.length;
		this.routines = this.routines.filter((r) => r.id !== id);
		if (this.routines.length < before) {
			this.save();
			return true;
		}
		return false;
	}

	/** Get all routines */
	list(): Routine[] {
		return [...this.routines];
	}

	/** Get a routine by ID */
	get(id: string): Routine | null {
		return this.routines.find((r) => r.id === id) || null;
	}

	/** Enable a routine */
	enable(id: string): void {
		const routine = this.routines.find((r) => r.id === id);
		if (routine) {
			routine.enabled = true;
			routine.updatedAt = new Date().toISOString();
			this.save();
		}
	}

	/** Disable a routine */
	disable(id: string): void {
		const routine = this.routines.find((r) => r.id === id);
		if (routine) {
			routine.enabled = false;
			routine.updatedAt = new Date().toISOString();
			this.save();
		}
	}

	/**
	 * Check all enabled routines and run any that are due.
	 * Call this every minute from the daemon loop.
	 */
	async tick(): Promise<RoutineRun[]> {
		const now = new Date();
		const runs: RoutineRun[] = [];

		for (const routine of this.routines) {
			if (!routine.enabled) continue;
			if (!cronMatches(routine.schedule, now)) continue;

			const run = await this.execute(routine, "schedule");
			runs.push(run);
		}

		return runs;
	}

	/**
	 * Manually trigger a routine (e.g. from API or webhook).
	 */
	async trigger(
		id: string,
		source: RoutineRun["trigger"] = "manual",
	): Promise<RoutineRun | null> {
		const routine = this.routines.find((r) => r.id === id);
		if (!routine) return null;
		return this.execute(routine, source);
	}

	/**
	 * Execute a routine by spawning a headless agent session.
	 */
	private async execute(
		routine: Routine,
		trigger: RoutineRun["trigger"],
	): Promise<RoutineRun> {
		const runId = crypto.randomUUID().slice(0, 8);
		const run: RoutineRun = {
			id: runId,
			startedAt: new Date().toISOString(),
			status: "running",
			trigger,
		};

		try {
			const args = [
				"run",
				"bin/8gent.ts",
				"chat",
				routine.prompt,
				"--yes",
				"--json",
			];

			if (routine.model) args.push(`--model=${routine.model}`);

			const proc = Bun.spawn(["bun", ...args], {
				stdout: "pipe",
				stderr: "pipe",
				cwd: routine.cwd || process.cwd(),
			});

			// Timeout handling
			const timeoutMs = (routine.timeoutSeconds || 300) * 1000;
			const timeout = setTimeout(() => {
				proc.kill();
				run.status = "timeout";
				run.error = `Exceeded ${routine.timeoutSeconds}s timeout`;
			}, timeoutMs);

			const stdout = await new Response(proc.stdout).text();
			const exitCode = await proc.exited;
			clearTimeout(timeout);

			if (run.status !== "timeout") {
				run.status = exitCode === 0 ? "completed" : "failed";
				run.output = stdout.slice(0, 2000); // Keep last 2KB
				if (exitCode !== 0) {
					const stderr = await new Response(proc.stderr).text();
					run.error = stderr.slice(0, 500);
				}
			}
		} catch (err) {
			run.status = "failed";
			run.error = String(err);
		}

		run.completedAt = new Date().toISOString();

		// Keep last 10 runs
		if (!routine.history) routine.history = [];
		routine.history.push(run);
		if (routine.history.length > 10) {
			routine.history = routine.history.slice(-10);
		}
		routine.updatedAt = new Date().toISOString();
		this.save();

		return run;
	}
}

// ── Singleton ───────────────────────────────────────────────────

let _instance: RoutineManager | null = null;

export function getRoutineManager(): RoutineManager {
	if (!_instance) _instance = new RoutineManager();
	return _instance;
}
