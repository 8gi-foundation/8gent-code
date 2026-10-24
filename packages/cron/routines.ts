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
 * Routines are stored in <home>/.8gent/routines.json (home from resolveHome, so
 * EIGHT_HOME applies), mode 0600, and executed by the daemon's cron tick loop. Each run spawns a headless agent session.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { eightCliPath, safeBunFlags } from "../core/bun-flags";
import { resolveHome } from "../core/home";
import { cronMatches, dueSince } from "./index";

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

	/** Run once when a scheduled slot was missed (default true). Set false to opt out. */
	catchUp?: boolean;

	/** When the schedule last fired it (ISO). Persisted so a restart can catch up. */
	lastRun?: string;

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
	/** True when the path came from the home directory: only then is the directory ours to tighten. */
	private ownsDir: boolean;

	/** Where the store lives. */
	get storePath(): string {
		return this.filePath;
	}

	/**
	 * `dataPath` wins when given. Otherwise <home>/.8gent/routines.json, home from resolveHome(env)
	 * (EIGHT_HOME, then HOME or USERPROFILE, then the OS home), never a literal "~".
	 */
	constructor(dataPath?: string, env: Record<string, string | undefined> = process.env) {
		this.ownsDir = !dataPath;
		this.filePath = dataPath || path.join(resolveHome(env), ".8gent", "routines.json");
		this.tightenDir();
		this.routines = this.load();
	}

	/** The default data directory is 0700 even when something else created it wider. Never through a symlink. */
	private tightenDir(): void {
		if (!this.ownsDir) return;
		const dir = path.dirname(this.filePath);
		try {
			const st = fs.lstatSync(dir);
			// Take away group and other access; the owner's own bits are not ours to widen.
			if (st.isDirectory() && (st.mode & 0o077) !== 0) fs.chmodSync(dir, st.mode & 0o700);
		} catch {}
	}

	/**
	 * A missing file is an empty store. A file that cannot be read as a list of routines is never
	 * overwritten: it is moved aside to routines.json.corrupt-<time> (0600) and the store starts
	 * empty. If it cannot be moved aside, this throws rather than risk losing it.
	 */
	private load(): Routine[] {
		if (!fs.existsSync(this.filePath)) return [];
		let raw: string;
		try {
			raw = fs.readFileSync(this.filePath, "utf-8");
		} catch (err) {
			throw new Error(`routines store ${this.filePath} cannot be read: ${(err as Error).message}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		if (Array.isArray(parsed)) {
			// A store written before 0600 existed: tighten it now.
			try {
				fs.chmodSync(this.filePath, 0o600);
			} catch {}
			return parsed as Routine[];
		}
		const aside = this.moveAside();
		console.warn(
			`[routines] ${this.filePath} was not valid JSON; kept as ${aside} and started empty`,
		);
		return [];
	}

	/**
	 * Keep the unreadable file under routines.json.corrupt-<time>[-n], never replacing an earlier
	 * backup: the copy is created exclusively (a taken name moves to the next suffix), then the
	 * original is removed. Throws, leaving the original in place, if no copy can be made.
	 */
	private moveAside(): string {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const refuse = (why: string) =>
			new Error(
				`routines store ${this.filePath} is not valid and could not be moved aside (${why}); left untouched`,
			);
		for (let n = 0; n < 1000; n++) {
			const aside = `${this.filePath}.corrupt-${stamp}${n ? `-${n}` : ""}`;
			try {
				fs.copyFileSync(this.filePath, aside, fs.constants.COPYFILE_EXCL);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw refuse((err as Error).message);
			}
			try {
				fs.chmodSync(aside, 0o600);
				fs.unlinkSync(this.filePath);
			} catch (err) {
				throw refuse((err as Error).message);
			}
			return aside;
		}
		throw refuse("too many backups exist");
	}

	/** Write a temp file (0600, never through a symlink) and rename it over the store: atomic. */
	private save(): void {
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.tightenDir();
		const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
		const fd = fs.openSync(
			tmp,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				(fs.constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			fs.writeSync(fd, JSON.stringify(this.routines, null, 2));
			fs.fchmodSync(fd, 0o600);
		} catch (err) {
			fs.closeSync(fd);
			fs.rmSync(tmp, { force: true });
			throw err;
		}
		fs.closeSync(fd);
		try {
			fs.renameSync(tmp, this.filePath);
		} catch (err) {
			fs.rmSync(tmp, { force: true });
			throw err;
		}
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
	async tick(now: Date = new Date()): Promise<RoutineRun[]> {
		const runs: RoutineRun[] = [];

		for (const routine of this.routines) {
			if (!routine.enabled) continue;
			// Baseline is createdAt so a new routine never replays slots from before it existed.
			const lastRun = routine.catchUp === false ? undefined : routine.lastRun || routine.createdAt;
			if (!dueSince(routine.schedule, lastRun, now)) continue;
			if (!cronMatches(routine.schedule, now)) {
				console.log(
					`[routines] catch-up: "${routine.name}" (${routine.id}) missed its slot since ${lastRun}, running once`,
				);
			}
			routine.lastRun = now.toISOString();
			this.save();

			const run = await this.execute(routine, "schedule");
			runs.push(run);
		}

		return runs;
	}

	/**
	 * Manually trigger a routine (e.g. from API or webhook).
	 */
	async trigger(id: string, source: RoutineRun["trigger"] = "manual"): Promise<RoutineRun | null> {
		const routine = this.routines.find((r) => r.id === id);
		if (!routine) return null;
		return this.execute(routine, source);
	}

	/**
	 * Execute a routine by spawning a headless agent session.
	 */
	private async execute(routine: Routine, trigger: RoutineRun["trigger"]): Promise<RoutineRun> {
		const runId = crypto.randomUUID().slice(0, 8);
		const run: RoutineRun = {
			id: runId,
			startedAt: new Date().toISOString(),
			status: "running",
			trigger,
		};

		try {
			// 8gent's own CLI by absolute path, and no bunfig.toml or .env from routine.cwd (#4013).
			const cli = eightCliPath();
			if (!cli) throw new Error("8gent CLI entry not found for this install");
			const args = ["run", cli, "chat", routine.prompt, "--yes", "--json"];

			if (routine.model) args.push(`--model=${routine.model}`);

			const proc = Bun.spawn(["bun", ...safeBunFlags(), ...args], {
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
