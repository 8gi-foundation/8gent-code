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
	const a = bus.on("tool:result", (p) => {
		if (p.sessionId === "cron") results.push(p.output);
	});
	const b = bus.on("tool:start", (p) => {
		if (p.sessionId === "cron") starts.push(p.tool);
	});
	try {
		await cron.startCron();
	} finally {
		bus.off(a);
		bus.off(b);
	}
	const saved = JSON.parse(readFileSync(cronPath, "utf8")) as Record<string, unknown>[];
	return { results, starts, saved };
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

	it("flag on: shell jobs ignore `when` and run as today", async () => {
		process.env.EIGHT_CRON_WHEN = "1";
		const { results, saved } = await run([job({ type: "shell", payload: "echo hi", when: "exit 1" })]);
		expect(results).toEqual(["hi\n"]);
		expect(saved[0].skips).toBeUndefined();
	});
});
