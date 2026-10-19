import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CronManager, dueSince } from "./index";
import { RoutineManager } from "./routines";

type Internals = {
	routines: Record<string, unknown>[];
	save(): void;
	execute(r: { name: string }, trigger: string): Promise<unknown>;
};

const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 9, d, h, m, s);

describe("dueSince", () => {
	test("exact minute with no lastRun is due", () => {
		expect(dueSince("0 3 * * *", undefined, at(19, 3, 0, 10))).toBe(true);
	});
	test("no lastRun and not the exact minute is not due", () => {
		expect(dueSince("0 3 * * *", undefined, at(19, 3, 7))).toBe(false);
	});
	test("same minute already run is not due again", () => {
		expect(dueSince("0 3 * * *", at(19, 3, 0, 10), at(19, 3, 0, 40))).toBe(false);
	});
	test("missed slot is due on the next tick", () => {
		expect(dueSince("0 3 * * *", at(18, 3, 0), at(19, 3, 7))).toBe(true);
	});
	test("slot older than the 24h cap is dropped", () => {
		expect(dueSince("0 3 * * *", at(10, 3, 0), at(19, 3, 7))).toBe(true); // 03:00 today is in cap
		expect(dueSince("0 3 * * *", at(10, 3, 0), at(19, 12, 0))).toBe(true); // 03:00 today, 9h ago
		expect(dueSince("0 3 * * *", at(10, 3, 0), at(20, 3, 30))).toBe(true);
		expect(dueSince("30 3 * * 3", at(1, 0, 0), at(19, 12, 0))).toBe(false); // weekly slot beyond 24h
	});
});

describe("RoutineManager catch-up", () => {
	let dir: string;
	let file: string;
	let fired: string[];
	const make = () => {
		const mgr = new RoutineManager(file);
		fired = [];
		(mgr as unknown as Internals).execute = async (r, trigger) => {
			fired.push(`${r.name}:${trigger}`);
			return { id: "x", startedAt: "", status: "completed", trigger };
		};
		return mgr;
	};
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-catchup-"));
		file = path.join(dir, "routines.json");
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const seed = (mgr: RoutineManager, extra: Record<string, unknown> = {}) => {
		const r = mgr.create({ name: "nightly", prompt: "p", schedule: "0 3 * * *" });
		const live = (mgr as unknown as Internals).routines[0];
		live.createdAt = at(1, 0, 0).toISOString();
		live.lastRun = at(18, 3, 0).toISOString();
		Object.assign(live, extra);
		(mgr as unknown as Internals).save();
		return r;
	};

	test("exact-minute tick still fires once", async () => {
		const mgr = make();
		seed(mgr);
		await mgr.tick(at(19, 3, 0, 5));
		await mgr.tick(at(19, 3, 0, 40));
		expect(fired).toEqual(["nightly:schedule"]);
	});

	test("missed slot fires once on the next tick", async () => {
		const mgr = make();
		seed(mgr);
		await mgr.tick(at(19, 3, 7));
		await mgr.tick(at(19, 3, 8));
		expect(fired).toEqual(["nightly:schedule"]);
	});

	test("several missed slots still fire once", async () => {
		const mgr = make();
		seed(mgr, { schedule: "*/10 * * * *", lastRun: at(19, 9, 0).toISOString() });
		await mgr.tick(at(19, 11, 5));
		await mgr.tick(at(19, 11, 6));
		expect(fired).toEqual(["nightly:schedule"]);
	});

	test("catchUp:false does not fire a missed slot but still fires exact", async () => {
		const mgr = make();
		seed(mgr, { catchUp: false });
		await mgr.tick(at(19, 3, 7));
		expect(fired).toEqual([]);
		await mgr.tick(at(20, 3, 0, 2));
		expect(fired).toEqual(["nightly:schedule"]);
	});

	test("restart persistence: lastRun survives a reload, first tick after restart catches up once", async () => {
		const a = make();
		seed(a);
		await a.tick(at(19, 3, 0, 1)); // fires, records lastRun
		const persisted = JSON.parse(fs.readFileSync(file, "utf-8"))[0];
		expect(new Date(persisted.lastRun).getTime()).toBe(at(19, 3, 0, 1).getTime());

		// daemon down over the 20th 03:00 slot, restart at 03:20
		const b = make();
		await b.tick(at(20, 3, 20));
		expect(fired).toEqual(["nightly:schedule"]);
		const c = make();
		await c.tick(at(20, 3, 21));
		expect(fired).toEqual([]);
	});

	test("brand new routine does not catch up slots before it existed", async () => {
		const mgr = make();
		mgr.create({ name: "fresh", prompt: "p", schedule: "0 3 * * *" });
		await mgr.tick(new Date(Date.now() + 1000));
		expect(fired.length).toBeLessThanOrEqual(1);
	});

	test("one log line per catch-up", async () => {
		const mgr = make();
		seed(mgr);
		const lines: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => void lines.push(a.join(" "));
		try {
			await mgr.tick(at(19, 3, 7));
		} finally {
			console.log = orig;
		}
		expect(lines.filter((l) => l.includes("catch-up"))).toHaveLength(1);
	});
});

describe("CronManager catch-up", () => {
	test("missed job fires once, catchUp:false does not", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-catchup-"));
		const mgr = new CronManager(path.join(dir, "cron.json"));
		const a = mgr.add({
			name: "a",
			schedule: "0 3 * * *",
			command: "chat x",
			enabled: true,
			lastRun: at(18, 3, 0).toISOString(),
		});
		const b = mgr.add({
			name: "b",
			schedule: "0 3 * * *",
			command: "chat y",
			enabled: true,
			lastRun: at(18, 3, 0).toISOString(),
			catchUp: false,
		});
		const spawned: unknown[] = [];
		const realSpawn = Bun.spawn;
		(Bun as unknown as { spawn: unknown }).spawn = (cmd: string[]) => void spawned.push(cmd);
		try {
			mgr.tick(at(19, 3, 7));
			mgr.tick(at(19, 3, 8));
		} finally {
			(Bun as unknown as { spawn: unknown }).spawn = realSpawn;
			fs.rmSync(dir, { recursive: true, force: true });
		}
		expect(spawned).toHaveLength(1);
		expect(mgr.list().find((j) => j.id === a.id)?.lastRun).toBeTruthy();
		expect(mgr.list().find((j) => j.id === b.id)?.lastRun).toBe(at(18, 3, 0).toISOString());
	});
});
