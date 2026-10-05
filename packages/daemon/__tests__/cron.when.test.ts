/**
 * Tests for the cron `when` watcher gate (#3505).
 *
 * Drives the real path a job ships through: cron.json on disk, startCron(),
 * the restart catchup that calls executeJob, and the events it emits on the
 * daemon bus. HOME points at a fresh temp dir, so the real ~/.8gent is never
 * read or written. No network: webhook jobs are not exercised here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cron = typeof import("../cron");
type Bus = typeof import("../events")["bus"];

const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "cron-when-"));
const cronPath = join(home, ".8gent", "cron.json");
let cron: Cron;
let bus: Bus;

beforeAll(async () => {
	process.env.HOME = home;
	mkdirSync(join(home, ".8gent"), { recursive: true });
	// Query suffix = a fresh module instance, so CRON_PATH (captured at import)
	// sees this HOME even when another test file imported cron.ts first.
	cron = (await import("../cron?when-test" as string)) as Cron;
	bus = (await import("../events")).bus;
});

afterAll(() => {
	process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
	cron.stopCron();
	delete process.env.EIGHT_CRON_WHEN;
});

/** A recurring job whose last run is an hour old, so startCron's catchup fires it once. */
function job(over: Record<string, unknown> = {}) {
	return {
		id: "j1",
		name: "review",
		expression: "*/5 * * * *",
		type: "agent-prompt",
		payload: "review the open issues",
		enabled: true,
		lastRun: new Date(Date.now() - 3_600_000).toISOString(),
		nextRun: null,
		recurring: true,
		...over,
	};
}

/** Write the jobs, start the scheduler (catchup runs them), return what the bus saw. */
async function run(jobs: Record<string, unknown>[]) {
	writeFileSync(cronPath, JSON.stringify(jobs, null, 2));
	const results: unknown[] = [];
	const starts: string[] = [];
	const checks: { input?: unknown; output?: unknown }[] = [];
	const a = bus.on("tool:result", (p) => {
		if (p.sessionId !== "cron") return;
		if (p.tool === "cron:when") checks.push({ output: p.output });
		else results.push(p.output);
	});
	const b = bus.on("tool:start", (p) => {
		if (p.sessionId !== "cron") return;
		if (p.tool === "cron:when") checks.push({ input: p.input });
		else starts.push(p.tool);
	});
	try {
		await cron.startCron();
	} finally {
		bus.off(a);
		bus.off(b);
	}
	const saved = JSON.parse(readFileSync(cronPath, "utf8")) as Record<string, unknown>[];
	return { results, starts, checks, saved };
}

/** True once `pid` no longer exists (polls up to 1 s for the kernel to finish). */
async function gone(pid: number): Promise<boolean> {
	for (let i = 0; i < 20; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(50);
	}
	return false;
}

/** Run a check that records its background child's pid; assert that child is dead afterwards. */
async function expectNoSurvivor(check: (pidFile: string) => string, wantQueued: boolean) {
	process.env.EIGHT_CRON_WHEN = "1";
	const pidFile = join(home, `child-${Math.random().toString(36).slice(2)}.pid`);
	let pid = 0;
	try {
		const { results } = await run([job({ when: check(pidFile) })]);
		pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(pid).toBeGreaterThan(0);
		expect(results).toEqual(wantQueued ? [queued] : []);
		expect(await gone(pid)).toBe(true);
	} finally {
		if (pid > 0) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
}

const queued = { prompt: "review the open issues", queued: true };

describe("cron when gate", () => {
	it("flag off: a job with `when` queues exactly as today and gains no new fields", async () => {
		const { results, saved } = await run([job({ when: "exit 1" })]);
		expect(results).toEqual([queued]);
		expect(Object.keys(saved[0]).sort()).toEqual(Object.keys(job({ when: "exit 1" })).sort());
	});

	it("flag on, exit 0: the prompt is queued", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { results, saved } = await run([job({ when: "exit 0" })]);
		expect(results).toEqual([queued]);
		expect(saved[0].skips).toBe(0);
	});

	it("flag on, non-zero exit: skipped, nothing queued, lastRun untouched, skip counted", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const before = job({ when: "exit 1" });
		const { results, starts, saved } = await run([before]);
		expect(results).toEqual([]);
		expect(starts).toEqual([]);
		expect(saved[0].lastRun).toBe(before.lastRun);
		expect(saved[0].skips).toBe(1);
	});

	it("flag on, check cannot run (command not found): fails open and queues", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { results } = await run([job({ when: "definitely-not-a-command-3505" })]);
		expect(results).toEqual([queued]);
	});

	it(
		"flag on, check times out: fails open and queues",
		async () => {
			process.env.EIGHT_CRON_WHEN = "1";
			const t0 = Date.now();
			const { results } = await run([job({ when: "sleep 30" })]);
			expect(results).toEqual([queued]);
			expect(Date.now() - t0).toBeLessThan(10_000);
		},
		15_000,
	);

	it("flag on, maxSkips reached: runs anyway and resets the counter", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { results, saved } = await run([job({ when: "exit 1", maxSkips: 2, skips: 2 })]);
		expect(results).toEqual([queued]);
		expect(saved[0].skips).toBe(0);
	});

	it("flag on, below maxSkips: still skips", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { results, saved } = await run([job({ when: "exit 1", maxSkips: 3, skips: 1 })]);
		expect(results).toEqual([]);
		expect(saved[0].skips).toBe(2);
	});

	it("flag on, one-shot job skipped: consumed, not left pending", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { results, saved } = await run([job({ when: "exit 1", recurring: false })]);
		expect(results).toEqual([]);
		expect(saved[0].enabled).toBe(false);
		expect(saved[0].skips).toBe(1);
	});

	it("flag on: the check itself is reported on the bus as cron:when", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { checks } = await run([job({ when: "exit 3" })]);
		expect(checks).toEqual([
			{ input: "exit 3" },
			{ output: { command: "exit 3", exitCode: 3, outcome: "skip" } },
		]);
	});

	it("flag on: a background child of a check that exits is killed", async () => {
		await expectNoSurvivor((f) => `sleep 47 & echo $! > ${f}; exit 1`, false);
	});

	it(
		"flag on: a compound check that times out leaves no live child",
		async () => {
			await expectNoSurvivor((f) => `sleep 47 & echo $! > ${f}; wait`, true);
		},
		15_000,
	);

	it(
		"flag on: a TERM-trapping check that times out leaves no live child",
		async () => {
			await expectNoSurvivor((f) => `trap '' TERM; sleep 47 & echo $! > ${f}; wait`, true);
		},
		15_000,
	);

	it("flag on: shell jobs ignore `when` and run as today", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { results, saved } = await run([job({ type: "shell", payload: "echo hi", when: "exit 1" })]);
		expect(results).toEqual(["hi\n"]);
		expect(saved[0].skips).toBeUndefined();
	});
});
