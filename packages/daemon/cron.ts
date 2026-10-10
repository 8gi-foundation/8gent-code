/**
 * Cron - Job scheduler for the daemon.
 *
 * Supports cron expressions, one-shot and recurring jobs,
 * persistence to <data dir>/cron.json, and restart catchup (#3851, epic #3849).
 *
 * cron.json is the source of truth: it is re-read every tick and every write
 * is read-modify-write, so an edit made while the daemon runs is never lost.
 * Jobs may set cwd, env and heavy. At most one heavy job runs at a time (lock
 * file holding a pid) and a heavy job is deferred while free memory is under
 * the floor. Deferred jobs retry on the next tick and do not count as run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellInvocation } from "../core/shell";
import { getDataDir } from "./data-dir";
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
	/** shell jobs: working directory (default: the data dir, not the launchd cwd) */
	cwd?: string;
	/** shell jobs: env merged over the daemon env */
	env?: Record<string, string>;
	/** at most one heavy job runs at a time; deferred when memory is low */
	heavy?: boolean;
}

const DEFAULT_MEM_FLOOR_PCT = 20;
const MAX_LOOKBACK_MIN = 7 * 24 * 60;
const ONCE_CATCHUP_MS = 24 * 60 * 60_000;

const cronPath = () => path.join(getDataDir(), "cron.json");
const lockPath = () => path.join(getDataDir(), "cron-heavy.lock");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate a log past this, and cap one run at this
const MAX_CATCHUP_PER_BOOT = 10;
const MAX_PAYLOAD = 64 * 1024;

/** Log file for a job. Id is reduced to a safe basename (no traversal, no dotfile). */
export function logPath(id: string): string {
	const dir = path.join(getDataDir(), "cron-logs");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {}
	const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 100) || "_";
	const p = path.join(dir, `${safe}.log`);
	try {
		if (fs.statSync(p).size > MAX_LOG_BYTES) fs.renameSync(p, `${p}.1`);
	} catch {}
	return p;
}

/** Append to a log, creating it 0600. */
function logAppend(file: string, text: string): void {
	fs.appendFileSync(file, text, { mode: 0o600 });
}

/** Env for a child: string values only, sane keys. Drops anything else. */
export function cleanEnv(env: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!env || typeof env !== "object") return out;
	for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
		if (typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !v.includes("\0")) out[k] = v;
	}
	return out;
}

/** Validate a job handed in over the wire. null = reject. */
export function validateJob(j: unknown): CronJob | null {
	const o = j as Partial<CronJob> | null;
	if (!o || typeof o !== "object") return null;
	if (typeof o.id !== "string" || !o.id || o.id.length > 128) return null;
	if (typeof o.name !== "string" || !o.name || o.name.length > 200) return null;
	if (typeof o.expression !== "string" || o.expression.length > 200) return null;
	const okExpr = o.expression.startsWith("once:")
		? !Number.isNaN(new Date(o.expression.slice(5)).getTime())
		: o.expression.trim().split(/\s+/).length === 5;
	if (!okExpr) return null;
	if (o.type !== "shell" && o.type !== "agent-prompt" && o.type !== "webhook") return null;
	if (typeof o.payload !== "string" || o.payload.length > MAX_PAYLOAD) return null;
	if (o.cwd !== undefined && (typeof o.cwd !== "string" || !path.isAbsolute(o.cwd))) return null;
	return {
		id: o.id,
		name: o.name,
		expression: o.expression,
		type: o.type,
		payload: o.payload,
		enabled: o.enabled !== false,
		lastRun: null,
		nextRun: null,
		recurring: o.recurring !== false,
		...(o.cwd ? { cwd: o.cwd } : {}),
		...(o.env ? { env: cleanEnv(o.env) } : {}),
		...(o.heavy ? { heavy: true } : {}),
	};
}

/** Memory reading. os.freemem on macOS counts only never-touched pages and
 * ignores reclaimable cache, so read vm_stat there: free + inactive + speculative + purgeable. */
export function parseVmStat(text: string): { free: number; total: number } | null {
	const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
	if (!size) return null;
	const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
	const free = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
	const total = free + pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor");
	return total > 0 ? { free: free * size, total: total * size } : null;
}
function readFreeMem(): number {
	if (process.platform === "darwin") {
		try {
			const r = Bun.spawnSync(["/usr/bin/vm_stat"]);
			const v = parseVmStat(r.stdout.toString());
			if (v) return (v.free / v.total) * os.totalmem();
		} catch {}
	}
	return os.freemem();
}

let jobs: CronJob[] = [];
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let lastTickMinute = 0;
const lastFired = new Map<string, number>(); // job id -> minute epoch last fired
const running = new Set<string>();
const pending = new Set<string>(); // due but deferred, retried next tick
let writeChain: Promise<unknown> = Promise.resolve();

/** Test seam: memory readings. Defaults to os.freemem / os.totalmem. */
export const cronHooks = {
	freeMem: () => readFreeMem(),
	totalMem: () => os.totalmem(),
	memFloorPct: () => {
		const v = Number(process.env.EIGHT_CRON_MEM_FLOOR_PCT);
		return Number.isFinite(v) && v > 0 && v < 100 ? v : DEFAULT_MEM_FLOOR_PCT;
	},
};

/** Read the file. null = unreadable/corrupt (never overwrite it), [] = absent. */
function readFile(): CronJob[] | null {
	try {
		const p = cronPath();
		if (!fs.existsSync(p)) return [];
		const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Re-read cron.json into memory; keep the later lastRun of file vs memory. */
function refresh(): void {
	const fromFile = readFile();
	if (!fromFile) return;
	const mem = new Map(jobs.map((j) => [j.id, j]));
	jobs = fromFile.map((j) => {
		const m = mem.get(j.id);
		if (m?.lastRun && (!j.lastRun || m.lastRun > j.lastRun)) j.lastRun = m.lastRun;
		return j;
	});
}

/** Read-modify-write, serialized, atomic rename. Aborts if the file is corrupt. */
function mutate(fn: (list: CronJob[]) => void): Promise<void> {
	writeChain = writeChain
		.catch(() => {})
		.then(() => {
			const list = readFile();
			if (!list) {
				console.error("[cron] cron.json unreadable, refusing to overwrite it");
				return;
			}
			fn(list);
			const tmp = `${cronPath()}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 }); // env may hold secrets
			fs.renameSync(tmp, cronPath());
			jobs = list;
		});
	return writeChain as Promise<void>;
}

export async function loadJobs(): Promise<CronJob[]> {
	refresh();
	return jobs;
}

const FIELD_RANGE: Array<[number, number]> = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
];

function fieldMatches(part: string, value: number, i: number): boolean {
	// day-of-week: 7 also means Sunday
	if (i === 4 && value === 0 && fieldMatchesRaw(part, 7, i)) return true;
	return fieldMatchesRaw(part, value, i);
}

function fieldMatchesRaw(part: string, value: number, i: number): boolean {
	return part.split(",").some((item) => {
		const [rangePart, stepPart] = item.split("/");
		const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
		if (!Number.isFinite(step) || step < 1) return false;
		let lo: number;
		let hi: number;
		if (rangePart === "*") {
			[lo, hi] = FIELD_RANGE[i];
		} else if (rangePart.includes("-")) {
			[lo, hi] = rangePart.split("-").map(Number);
		} else {
			lo = Number(rangePart);
			hi = stepPart === undefined ? lo : FIELD_RANGE[i][1];
		}
		if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
		return value >= lo && value <= hi && (value - lo) % step === 0;
	});
}

/** Check if an expression matches the minute containing `now` */
export function matchesCron(expr: string, now: Date): boolean {
	if (expr.startsWith("once:")) {
		const target = new Date(expr.slice(5)).getTime();
		return Math.floor(target / 60_000) === Math.floor(now.getTime() / 60_000);
	}
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const fields = [
		now.getMinutes(),
		now.getHours(),
		now.getDate(),
		now.getMonth() + 1,
		now.getDay(),
	];
	return parts.every((part, i) => fieldMatches(part, fields[i], i));
}

/** Most recent scheduled minute at or before `now` (looks back 7 days). */
export function previousScheduled(expr: string, now: Date): Date | null {
	if (expr.startsWith("once:")) {
		const t = new Date(expr.slice(5));
		return Number.isNaN(t.getTime()) || t > now ? null : t;
	}
	const base = Math.floor(now.getTime() / 60_000) * 60_000;
	for (let i = 0; i < MAX_LOOKBACK_MIN; i++) {
		const d = new Date(base - i * 60_000);
		if (matchesCron(expr, d)) return d;
	}
	return null;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

const bootMs = () => Math.round((Date.now() - os.uptime() * 1000) / 60_000) * 60_000;
const lockBody = (pid: number, job: string) => JSON.stringify({ pid, job, boot: bootMs() });
/** A lock is live only if its pid is alive AND it was written in this boot (pids get reused). */
function lockLive(raw: string): boolean {
	try {
		const l = JSON.parse(raw);
		if (!l.pid || !isAlive(l.pid)) return false;
		if (typeof l.boot === "number" && Math.abs(l.boot - bootMs()) > 5 * 60_000) return false;
		return true;
	} catch {
		return false;
	}
}

/** Take the heavy lock. false = another live heavy job holds it. Dead pid is cleared. */
function acquireHeavy(jobId: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(lockPath(), "wx", 0o600); // O_EXCL: never follows a symlink
			fs.writeSync(fd, lockBody(process.pid, jobId));
			fs.closeSync(fd);
			return true;
		} catch {
			let raw = "";
			try {
				raw = fs.readFileSync(lockPath(), "utf8");
			} catch {}
			if (raw && lockLive(raw)) return false;
			console.log("[cron] clearing stale heavy lock");
			try {
				// re-read: only unlink if it is still the stale one we judged
				if (fs.readFileSync(lockPath(), "utf8") === raw) fs.unlinkSync(lockPath());
			} catch {}
		}
	}
	return false;
}

function setHeavyPid(jobId: string, pid: number): void {
	try {
		const cur = fs.readFileSync(lockPath(), "utf8");
		if (JSON.parse(cur).job === jobId) fs.writeFileSync(lockPath(), lockBody(pid, jobId), { mode: 0o600 });
	} catch {}
}

function releaseHeavy(jobId: string): void {
	try {
		const cur = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
		if (cur.job === jobId) fs.unlinkSync(lockPath());
	} catch {}
}

async function drain(
	stream: ReadableStream<Uint8Array> | null | undefined,
	file: string,
	tail: { text: string },
	capture: boolean,
): Promise<void> {
	if (!stream) return;
	const dec = new TextDecoder();
	let written = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		const text = dec.decode(chunk, { stream: true });
		if (written < MAX_LOG_BYTES) {
			logAppend(file, text);
			written += text.length;
			if (written >= MAX_LOG_BYTES) logAppend(file, "\n[log capped for this run]\n");
		}
		if (capture) tail.text = (tail.text + text).slice(-4000);
	}
}

async function executeJob(job: CronJob): Promise<void> {
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
			const log = logPath(job.id);
			logAppend(log, `\n=== ${new Date().toISOString()} ${job.name.replace(/[\r\n]/g, " ")} ===\n`);
			const sh = shellInvocation(job.payload);
			const proc = Bun.spawn([sh.file, ...sh.args], {
				cwd: job.cwd || getDataDir(),
				env: { ...process.env, ...cleanEnv(job.env) },
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				windowsVerbatimArguments: sh.windowsVerbatimArguments,
			});
			if (job.heavy) setHeavyPid(job.id, proc.pid);
			const out = { text: "" };
			await Promise.all([
				drain(proc.stdout as ReadableStream<Uint8Array>, log, out, true),
				drain(proc.stderr as ReadableStream<Uint8Array>, log, { text: "" }, false),
			]);
			const code = await proc.exited;
			logAppend(log, `\n=== exit ${code} (${Date.now() - startMs}ms) ===\n`);
			output = out.text;
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

	const ran = new Date().toISOString();
	await mutate((list) => {
		const j = list.find((x) => x.id === job.id);
		if (!j) return; // removed while it ran
		j.lastRun = ran;
		if (!j.recurring) j.enabled = false;
	});
	job.lastRun = ran;
}

/**
 * Start a job if the heavy rules allow. Returns the run promise, or null when
 * deferred (job goes to `pending`, retried next tick, not counted as run).
 */
function dispatch(job: CronJob, minute: number): Promise<void> | null {
	if (running.has(job.id)) return null;
	if (job.heavy) {
		const free = (cronHooks.freeMem() / cronHooks.totalMem()) * 100;
		if (free < cronHooks.memFloorPct()) {
			console.log(`[cron] deferred: memory (${job.name}, ${free.toFixed(0)}% free)`);
			pending.add(job.id);
			return null;
		}
		if (!acquireHeavy(job.id)) {
			console.log(`[cron] deferred: heavy busy (${job.name})`);
			pending.add(job.id);
			return null;
		}
	}
	pending.delete(job.id);
	lastFired.set(job.id, minute);
	running.add(job.id);
	return executeJob(job)
		.catch((err) => console.error("[cron] job error:", err))
		.finally(() => {
			running.delete(job.id);
			if (job.heavy) releaseHeavy(job.id);
		});
}

/**
 * Process every minute since the last tick (so a late timer cannot skip one),
 * fire each job at most once per minute, and retry deferred jobs.
 * Resolves when the jobs started by this call have finished.
 */
export function tickAt(now: Date): Promise<void> {
	refresh();
	const cur = Math.floor(now.getTime() / 60_000);
	const from = lastTickMinute && cur - lastTickMinute <= 10 ? lastTickMinute + 1 : cur;
	lastTickMinute = cur;
	const runs: Promise<void>[] = [];
	const tried = new Set<string>();
	for (let m = from; m <= cur; m++) {
		const at = new Date(m * 60_000);
		for (const job of jobs) {
			if (!job.enabled || lastFired.get(job.id) === m) continue;
			if (matchesCron(job.expression, at)) {
				tried.add(job.id);
				const p = dispatch(job, m);
				if (p) runs.push(p);
			}
		}
	}
	for (const id of [...pending]) {
		if (tried.has(id)) continue;
		const job = jobs.find((j) => j.id === id);
		if (!job || !job.enabled) {
			pending.delete(id);
			continue;
		}
		const p = dispatch(job, cur);
		if (p) runs.push(p);
	}
	return Promise.all(runs).then(() => {});
}

/** After a restart: run each job at most once if a scheduled run was missed. */
export async function catchup(now: Date = new Date()): Promise<void> {
	refresh();
	const runs: Promise<void>[] = [];
	const cur = Math.floor(now.getTime() / 60_000);
	for (const job of jobs) {
		if (!job.enabled) continue;
		if (runs.length >= MAX_CATCHUP_PER_BOOT) {
			console.log(`[cron] catchup capped at ${MAX_CATCHUP_PER_BOOT}; the rest wait for their next slot`);
			break;
		}
		const prev = previousScheduled(job.expression, now);
		if (!prev) continue;
		const last = job.lastRun ? new Date(job.lastRun).getTime() : null;
		const isOnce = job.expression.startsWith("once:");
		if (last === null && !isOnce) continue; // never ran: nothing was missed
		if (isOnce && now.getTime() - prev.getTime() > ONCE_CATCHUP_MS) continue;
		if (last !== null && last >= prev.getTime()) continue;
		console.log(`[cron] catchup: running missed job ${job.name}`);
		const p = dispatch(job, Math.floor(prev.getTime() / 60_000));
		if (p) runs.push(p);
	}
	lastTickMinute = cur;
	await Promise.all(runs);
}

export async function startCron(): Promise<void> {
	await loadJobs();
	// Do not block startup on long catch-up runs.
	catchup().catch((err) => console.error("[cron] catchup error:", err));
	const arm = () => {
		// Aligned to the minute boundary; tickAt covers any minute a late timer missed.
		tickTimer = setTimeout(() => {
			tickAt(new Date()).catch((err) => console.error("[cron] tick error:", err));
			arm();
		}, 60_000 - (Date.now() % 60_000) + 25);
	};
	arm();
}

export function stopCron(): void {
	if (tickTimer) {
		clearTimeout(tickTimer);
		tickTimer = null;
	}
}

export function addJob(input: CronJob): boolean {
	const job = validateJob(input);
	if (!job) {
		console.error("[cron] addJob rejected: invalid job");
		return false;
	}
	jobs.push(job);
	mutate((list) => {
		if (!list.some((j) => j.id === job.id)) list.push(job);
	}).catch(console.error);
	return true;
}

export function removeJob(id: string): boolean {
	const idx = jobs.findIndex((j) => j.id === id);
	if (idx === -1) return false;
	jobs.splice(idx, 1);
	mutate((list) => {
		const i = list.findIndex((j) => j.id === id);
		if (i !== -1) list.splice(i, 1);
	}).catch(console.error);
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
