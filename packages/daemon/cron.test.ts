import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let dir: string;
let cron: typeof import("./cron");

const T = (iso: string) => new Date(iso);
const mk = (o: Partial<import("./cron").CronJob> & { id: string }): import("./cron").CronJob => ({
	name: o.id,
	expression: "* * * * *",
	type: "shell",
	payload: "true",
	enabled: true,
	lastRun: null,
	nextRun: null,
	recurring: true,
	...o,
});
const file = () => path.join(dir, "cron.json");
const write = (jobs: unknown) => fs.writeFileSync(file(), JSON.stringify(jobs));
const read = () => JSON.parse(fs.readFileSync(file(), "utf8"));
const logOf = (id: string) => fs.readFileSync(path.join(dir, "cron-logs", `${id}.log`), "utf8");

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
	process.env.EIGHT_DATA_DIR = dir;
	// fresh module state per test
	cron = await import(`./cron.ts?t=${Math.random()}`);
	cron.cronHooks.freeMem = () => 80;
	cron.cronHooks.totalMem = () => 100;
});
afterEach(() => {
	cron.stopCron();
	fs.rmSync(dir, { recursive: true, force: true });
	process.env.EIGHT_DATA_DIR = undefined as unknown as string;
	delete process.env.EIGHT_DATA_DIR;
});

describe("defect 1: edits survive", () => {
	test("an edit made on disk while running is not overwritten by a job run", async () => {
		write([mk({ id: "a", payload: "true" })]);
		await cron.loadJobs();
		// operator adds a job and edits a on disk after the daemon loaded
		write([mk({ id: "a", payload: "echo edited" }), mk({ id: "b", expression: "0 0 1 1 *" })]);
		await cron.tickAt(T("2026-10-10T12:00:00"));
		const onDisk = read();
		expect(onDisk.map((j: { id: string }) => j.id)).toEqual(["a", "b"]);
		expect(onDisk[0].payload).toBe("echo edited");
		expect(onDisk[0].lastRun).not.toBeNull();
	});
	test("addJob merges into the file instead of replacing it", async () => {
		write([mk({ id: "a", expression: "0 0 1 1 *" })]);
		await cron.loadJobs();
		write([mk({ id: "a", expression: "0 0 1 1 *" }), mk({ id: "hand", expression: "0 0 1 1 *" })]);
		cron.addJob(mk({ id: "c", expression: "0 0 1 1 *" }));
		await new Promise((r) => setTimeout(r, 50));
		expect(read().map((j: { id: string }) => j.id).sort()).toEqual(["a", "c", "hand"]);
	});
	test("a corrupt cron.json is never overwritten", async () => {
		fs.writeFileSync(file(), "{not json");
		cron.addJob(mk({ id: "x" }));
		await new Promise((r) => setTimeout(r, 50));
		expect(fs.readFileSync(file(), "utf8")).toBe("{not json");
	});
});

describe("defect 2 and 3: cwd, env, logs", () => {
	test("cwd and env apply and stdout plus stderr land in the per-job log", async () => {
		const wd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-cwd-")));
		write([mk({ id: "j", cwd: wd, env: { CRON_X: "hello" }, payload: "pwd; echo $CRON_X; echo oops 1>&2" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		const log = logOf("j");
		expect(log).toContain(wd);
		expect(log).toContain("hello");
		expect(log).toContain("oops");
		expect(log).toContain("exit 0");
		fs.rmSync(wd, { recursive: true, force: true });
	});
	test("a chatty stderr does not block the job", async () => {
		write([mk({ id: "loud", payload: "i=0; while [ $i -lt 3000 ]; do echo 0123456789012345678901234567890123456789 1>&2; i=$((i+1)); done; echo done" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		expect(logOf("loud")).toContain("done");
	});
});

describe("defect 4: catch-up for any expression", () => {
	test("hourly job missed across :00 runs once", async () => {
		write([mk({ id: "h", expression: "0 * * * *", lastRun: "2026-10-10T10:00:05" })]);
		await cron.loadJobs();
		await cron.catchup(T("2026-10-10T12:20:00"));
		expect(read()[0].lastRun > "2026-10-10T10:00:05").toBe(true);
		const first = read()[0].lastRun;
		await cron.catchup(T("2026-10-10T12:21:00")); // at most one catch-up
		expect(read()[0].lastRun).toBe(first);
	});
	test("a job that did not miss anything does not run", async () => {
		const last = new Date().toISOString();
		write([mk({ id: "h", expression: "0 * * * *", lastRun: last })]);
		await cron.loadJobs();
		await cron.catchup(new Date(Date.now() + 60_000));
		expect(read()[0].lastRun).toBe(last);
	});
	test("fixed-minute daily job and once job catch up; never-run recurring does not", async () => {
		write([
			mk({ id: "d", expression: "30 9 * * *", lastRun: "2026-10-08T09:30:01" }),
			mk({ id: "o", expression: "once:2026-10-10T11:00:00", recurring: false }),
			mk({ id: "n", expression: "0 * * * *" }),
		]);
		await cron.loadJobs();
		await cron.catchup(T("2026-10-10T12:00:30"));
		const byId = Object.fromEntries(read().map((j: { id: string }) => [j.id, j]));
		expect(byId.d.lastRun > "2026-10-08T09:30:01").toBe(true);
		expect(byId.o.lastRun).not.toBeNull();
		expect(byId.o.enabled).toBe(false);
		expect(byId.n.lastRun).toBeNull();
	});
});

describe("defect 5: minute alignment and last-fired guard", () => {
	test("the same minute ticked twice fires once", async () => {
		write([mk({ id: "m", payload: "echo hit" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:01"));
		await cron.tickAt(T("2026-10-10T12:00:40"));
		expect(logOf("m").match(/=== exit/g)?.length).toBe(1);
	});
	test("a late tick does not skip the minute in between", async () => {
		write([mk({ id: "m", expression: "1 12 * * *", payload: "echo hit" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:10"));
		await cron.tickAt(T("2026-10-10T12:02:05")); // 12:01 was skipped by the timer
		expect(logOf("m")).toContain("hit");
	});
	test("ranges and steps match", () => {
		expect(cron.matchesCron("0 9-17/2 * * 1-5", T("2026-10-09T11:00:00"))).toBe(true);
		expect(cron.matchesCron("0 9-17/2 * * 1-5", T("2026-10-09T12:00:00"))).toBe(false);
		expect(cron.matchesCron("0 9-17/2 * * 1-5", T("2026-10-10T11:00:00"))).toBe(false); // Saturday
	});
});

describe("heavy jobs", () => {
	test("two heavy jobs due at once: one runs, one defers and is retried", async () => {
		write([
			mk({ id: "h1", heavy: true, payload: "sleep 1; echo one" }),
			mk({ id: "h2", heavy: true, payload: "echo two" }),
		]);
		await cron.loadJobs();
		const run1 = cron.tickAt(T("2026-10-10T12:00:00"));
		expect(fs.existsSync(path.join(dir, "cron-heavy.lock"))).toBe(true);
		await run1;
		expect(fs.existsSync(path.join(dir, "cron-logs", "h2.log"))).toBe(false);
		expect(read().find((j: { id: string }) => j.id === "h2").lastRun).toBeNull(); // deferred is not run
		expect(fs.existsSync(path.join(dir, "cron-heavy.lock"))).toBe(false);
		await cron.tickAt(T("2026-10-10T12:00:00")); // same minute: h1 guarded, h2 retried
		expect(logOf("h2")).toContain("two");
	});
	test("a lock held by a dead pid is cleared", async () => {
		const p = Bun.spawnSync(["true"]);
		fs.writeFileSync(path.join(dir, "cron-heavy.lock"), JSON.stringify({ pid: p.pid, job: "ghost" }));
		write([mk({ id: "h", heavy: true, payload: "echo ran" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		expect(logOf("h")).toContain("ran");
	});
	test("a lock held by a live pid blocks", async () => {
		fs.writeFileSync(path.join(dir, "cron-heavy.lock"), JSON.stringify({ pid: process.pid, job: "other" }));
		write([mk({ id: "h", heavy: true })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		expect(read()[0].lastRun).toBeNull();
		expect(fs.existsSync(path.join(dir, "cron-heavy.lock"))).toBe(true);
	});
	test("low memory defers a heavy job, a light job still runs", async () => {
		cron.cronHooks.freeMem = () => 10; // 10 percent free, floor 20
		write([mk({ id: "h", heavy: true, payload: "echo h" }), mk({ id: "l", payload: "echo l" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		const byId = Object.fromEntries(read().map((j: { id: string }) => [j.id, j]));
		expect(byId.h.lastRun).toBeNull();
		expect(byId.l.lastRun).not.toBeNull();
		cron.cronHooks.freeMem = () => 50; // memory recovers: next tick runs it
		await cron.tickAt(T("2026-10-10T12:01:00"));
		expect(logOf("h")).toContain("h");
	});
});

describe("hardening (8SO)", () => {
	test("job id cannot escape the log dir; logs are 0600, dir 0700", async () => {
		write([mk({ id: "../../evil", payload: "echo hi" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		const lp = cron.logPath("../../evil");
		expect(path.dirname(lp)).toBe(path.join(dir, "cron-logs"));
		expect(path.basename(lp).startsWith(".")).toBe(false);
		expect(fs.statSync(lp).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.join(dir, "cron-logs")).mode & 0o777).toBe(0o700);
		expect(fs.existsSync(path.join(dir, "..", "evil.log"))).toBe(false);
	});
	test("a log over the cap is rotated, one run is capped", async () => {
		const lp = cron.logPath("big");
		fs.writeFileSync(lp, Buffer.alloc(5 * 1024 * 1024 + 10));
		cron.logPath("big");
		expect(fs.existsSync(`${lp}.1`)).toBe(true);
		expect(fs.existsSync(lp)).toBe(false);
	});
	test("cron.json is written 0600", async () => {
		write([mk({ id: "a", expression: "0 0 1 1 *" })]);
		await cron.loadJobs();
		cron.addJob(mk({ id: "b", expression: "0 0 1 1 *" }));
		await new Promise((r) => setTimeout(r, 50));
		expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
	});
	test("env is cleaned: bad keys and non-strings dropped, daemon env untouched", () => {
		expect(cron.cleanEnv({ OK: "1", "BAD KEY": "x", "A=B": "x", N: 5, Z: "a\0b" })).toEqual({ OK: "1" });
		expect(process.env.CRON_LEAK).toBeUndefined();
	});
	test("addJob rejects malformed or non-absolute-cwd jobs", () => {
		expect(cron.addJob({ ...mk({ id: "p" }), payload: 5 as unknown as string })).toBe(false);
		expect(cron.addJob({ ...mk({ id: "p" }), type: "rm" as never })).toBe(false);
		expect(cron.addJob({ ...mk({ id: "p" }), expression: "nope" })).toBe(false);
		expect(cron.addJob({ ...mk({ id: "p" }), cwd: "relative/dir" })).toBe(false);
		expect(cron.addJob({ ...mk({ id: "" }) })).toBe(false);
	});
	test("a lock from a previous boot with a recycled live pid is stale", async () => {
		const oldBoot = Date.now() - 86_400_000;
		fs.writeFileSync(path.join(dir, "cron-heavy.lock"), JSON.stringify({ pid: process.pid, job: "x", boot: oldBoot }));
		write([mk({ id: "h", heavy: true, payload: "echo ran" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		expect(logOf("h")).toContain("ran");
	});
	test("a symlink at the lock path is not followed for writes", async () => {
		const target = path.join(dir, "victim.txt");
		fs.writeFileSync(target, "keep");
		fs.symlinkSync(target, path.join(dir, "cron-heavy.lock"));
		write([mk({ id: "h", heavy: true, payload: "echo ran" })]);
		await cron.loadJobs();
		await cron.tickAt(T("2026-10-10T12:00:00"));
		expect(fs.readFileSync(target, "utf8")).toBe("keep");
	});
	test("catch-up at boot is capped", async () => {
		const jobs = Array.from({ length: 15 }, (_, i) =>
			mk({ id: `c${i}`, expression: "0 * * * *", lastRun: "2026-10-10T09:00:05", payload: "true" }),
		);
		write(jobs);
		await cron.loadJobs();
		await cron.catchup(T("2026-10-10T12:20:00"));
		expect(read().filter((j: { lastRun: string }) => j.lastRun > "2026-10-10T09:00:05").length).toBe(10);
	});
	test("vm_stat parsing counts reclaimable pages as free", () => {
		const txt = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                             4000.
Pages inactive:                           3000.
Pages speculative:                         500.
Pages wired down:                         1500.
Pages purgeable:                           500.
Pages occupied by compressor:                0.
`;
		const v = cron.parseVmStat(txt);
		expect(v).not.toBeNull();
		expect(v!.free / 16384).toBe(5000);
		expect(v!.total / 16384).toBe(10500);
	});
});
