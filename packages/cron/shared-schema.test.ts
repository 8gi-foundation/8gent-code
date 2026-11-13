/**
 * #255: `8gent cron add` and the daemon scheduler must read and write one row shape.
 * Drives the real path: CronManager (the CLI) writes cron.json, the daemon module loads it.
 * EIGHT_DATA_DIR points at a temp dir, so the real ~/.8gent is never touched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronManager } from "./index";

type Daemon = typeof import("../daemon/cron");

const dataDir = join(mkdtempSync(join(tmpdir(), "cron-255-")), ".8gent");
const file = join(dataDir, "cron.json");
const realDataDir = process.env.EIGHT_DATA_DIR;
let daemon: Daemon;

beforeAll(async () => {
	process.env.EIGHT_DATA_DIR = dataDir;
	mkdirSync(dataDir, { recursive: true });
	daemon = (await import("../daemon/cron?shared-255" as string)) as Daemon;
});

afterAll(() => {
	if (realDataDir === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = realDataDir;
	rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

afterEach(() => daemon.stopCron());

const daemonRow = {
	id: "keep-me",
	name: "existing",
	expression: "0 9 * * *",
	type: "agent-prompt",
	payload: "summarise",
	enabled: true,
	lastRun: null,
	nextRun: null,
	recurring: true,
};

describe("cron.json has one row shape (#255)", () => {
	test("a job written by the CLI is read back by the daemon loader", async () => {
		writeFileSync(file, JSON.stringify([daemonRow]));
		const job = new CronManager().add({
			name: "operation-loop",
			schedule: "*/30 * * * *",
			command: "chat 'check deploy'",
			enabled: true,
		});
		const loaded = await daemon.loadJobs();
		const mine = loaded.find((j) => j.id === job.id);
		expect(mine?.expression).toBe("*/30 * * * *");
		expect(mine?.type).toBe("shell");
		expect(mine?.payload).toContain("chat 'check deploy'");
		expect(mine?.enabled).toBe(true);
		expect(loaded.find((j) => j.id === "keep-me")).toMatchObject(daemonRow);
	});

	test("cron list shows expression and payload of daemon-shaped rows", () => {
		writeFileSync(file, JSON.stringify([daemonRow]));
		const [j] = new CronManager().list();
		expect(j.schedule).toBe("0 9 * * *");
		expect(j.command).toBe("summarise");
	});

	test("a row in the old CLI shape is still read, and is rewritten in the shared shape", async () => {
		writeFileSync(
			file,
			JSON.stringify([{ id: "old1", name: "old", schedule: "0 3 * * *", command: "chat x", enabled: true }]),
		);
		const loaded = await daemon.loadJobs();
		expect(loaded[0]).toMatchObject({ id: "old1", expression: "0 3 * * *", type: "shell", recurring: true });
		new CronManager().disable("old1");
		const onDisk = JSON.parse(readFileSync(file, "utf-8"));
		expect(onDisk[0].expression).toBe("0 3 * * *");
		expect(onDisk[0].schedule).toBeUndefined();
		expect(onDisk[0].enabled).toBe(false);
	});

	test("a malformed row is skipped, kept in the file, and does not stop the others", async () => {
		const bad = { id: "bad", name: "no expression" };
		writeFileSync(file, JSON.stringify([bad, "junk", daemonRow]));
		const loaded = await daemon.loadJobs();
		expect(loaded.map((j) => j.id)).toEqual(["keep-me"]);
		new CronManager().add({ name: "n", schedule: "* * * * *", command: "chat y", enabled: true });
		const onDisk = JSON.parse(readFileSync(file, "utf-8"));
		expect(onDisk).toContainEqual(bad);
		expect(onDisk).toContain("junk");
		expect(onDisk.some((r: { id: string }) => r.id === "keep-me")).toBe(true);
	});

	test("a job added by the CLI while the daemon runs fires on its minute, without a restart", async () => {
		writeFileSync(file, "[]");
		await daemon.startCron();
		const marker = join(dataDir, "fired");
		const job = new CronManager().add({
			name: "marker",
			schedule: "* * * * *",
			command: "x",
			enabled: true,
			type: "shell",
		});
		// swap the payload for a harmless shell line that proves it ran
		const rows = JSON.parse(readFileSync(file, "utf-8"));
		rows.find((r: { id: string }) => r.id === job.id).payload = `echo ok > "${marker}"`;
		writeFileSync(file, JSON.stringify(rows));
		const realSet = globalThis.setInterval;
		let tickFn: (() => void) | undefined;
		(globalThis as { setInterval: unknown }).setInterval = (fn: () => void) => {
			tickFn = fn;
			return 0;
		};
		daemon.stopCron();
		await daemon.startCron();
		globalThis.setInterval = realSet;
		expect(daemon.getJobs().some((j) => j.id === job.id)).toBe(true);
		// a second CLI add after startup, then one daemon tick
		const late = new CronManager().add({ name: "late", schedule: "* * * * *", command: "y", enabled: true });
		tickFn?.();
		expect(daemon.getJobs().some((j) => j.id === late.id)).toBe(true);
		await Bun.sleep(400);
		expect(readFileSync(marker, "utf-8").trim()).toBe("ok");
	});
});
