import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	RUNNER_STALE_MS,
	acquireRunner,
	addJob,
	loadJobs,
	releaseRunner,
	removeJob,
	runnerLockPath,
	startCron,
	stopCron,
} from "./cron";

let root: string;
const saved = { d: process.env.EIGHT_DATA_DIR, j: process.env.EIGHT_JOBS_DIR };
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "cronrunner-"));
	process.env.EIGHT_DATA_DIR = root;
	process.env.EIGHT_JOBS_DIR = path.join(root, "jobs");
});
afterEach(() => {
	stopCron();
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.d],
		["EIGHT_JOBS_DIR", saved.j],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

const T = 1_800_000_000_000;
const lock = () => JSON.parse(fs.readFileSync(runnerLockPath(), "utf8"));
function job(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		name: id,
		expression: "*/5 * * * *",
		type: "shell",
		payload: "true",
		enabled: true,
		lastRun: new Date().toISOString(),
		nextRun: null,
		recurring: true,
		...extra,
	};
}
const ids = () =>
	JSON.parse(fs.readFileSync(path.join(root, "cron.json"), "utf8")).map((j: { id: string }) => j.id);
const write = (jobs: unknown[]) => fs.writeFileSync(path.join(root, "cron.json"), JSON.stringify(jobs));
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

test("one process holds the runner lock, a second is refused, the holder may refresh", () => {
	expect(acquireRunner(T, 101)).toBe(true);
	expect(acquireRunner(T + 1000, 202)).toBe(false);
	expect(lock().pid).toBe(101);
	expect(acquireRunner(T + 60_000, 101)).toBe(true);
	expect(lock().heartbeat).toBe(T + 60_000);
});

test("a lock silent for 3 minutes is stale and can be taken, 1 minute is not", () => {
	acquireRunner(T, 101);
	expect(acquireRunner(T + 60_000, 202)).toBe(false);
	expect(acquireRunner(T + RUNNER_STALE_MS + 1, 202)).toBe(true);
	expect(lock().pid).toBe(202);
});

test("a garbled lock is judged by its file age", () => {
	fs.writeFileSync(runnerLockPath(), "{not json");
	expect(acquireRunner(Date.now(), 202)).toBe(false);
	expect(acquireRunner(Date.now() + RUNNER_STALE_MS + 1000, 202)).toBe(true);
});

test("release removes only our own lock", () => {
	acquireRunner(T, 101);
	releaseRunner(202);
	expect(fs.existsSync(runnerLockPath())).toBe(true);
	releaseRunner(101);
	expect(fs.existsSync(runnerLockPath())).toBe(false);
});

test("startCron skips catchup while another process is the runner", async () => {
	const marker = path.join(root, "ran");
	write([job("late", { payload: `touch ${marker}`, lastRun: hourAgo() })]);
	acquireRunner(Date.now(), 99_999_999);
	await startCron();
	expect(fs.existsSync(marker)).toBe(false);
});

test("startCron runs catchup when it holds the lock, and stopCron frees it", async () => {
	const marker = path.join(root, "ran");
	write([job("late", { payload: `touch ${marker}`, lastRun: hourAgo() })]);
	await startCron();
	expect(fs.existsSync(marker)).toBe(true);
	expect(lock().pid).toBe(process.pid);
	stopCron();
	expect(fs.existsSync(runnerLockPath())).toBe(false);
});

test("addJob and removeJob merge with what another process wrote, never clobber it", async () => {
	write([job("a")]);
	await loadJobs();
	write([job("a"), job("b")]);
	addJob(job("c") as never);
	await Bun.sleep(100);
	expect(ids()).toEqual(["a", "b", "c"]);
	write([job("a"), job("b"), job("c"), job("d")]);
	expect(removeJob("a")).toBe(true);
	await Bun.sleep(100);
	expect(ids()).toEqual(["b", "c", "d"]);
});

test("a job finishing writes its own run state and keeps jobs another process added", async () => {
	write([job("a", { lastRun: hourAgo() })]);
	await startCron(); // catchup runs "a" and saves
	write([job("a", { lastRun: hourAgo() }), job("b")]);
	addJob(job("z") as never);
	await Bun.sleep(100);
	expect(ids()).toEqual(["a", "b", "z"]);
});
