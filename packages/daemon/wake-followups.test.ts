import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "./events";
import type { Notice, WakeRouter } from "./wake-router";
import { pruneWakeFiles, startWakeRouter, wakeRouter } from "./wake-wiring";

// No bus.clear() and no lasting env change: other files in this process share both.
let dir: string;
let stop: (() => void) | null = null;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wake-fu-"));
});
afterEach(() => {
	stop?.();
	stop = null;
	rmSync(dir, { recursive: true, force: true });
});
const config = (wake: object) => writeFileSync(join(dir, "config.json"), JSON.stringify({ wake }));
const router = () => wakeRouter() as WakeRouter;
const quiet = { start: "22:00", end: "08:00" };
const fail = (error: string) => bus.emit("agent:error", { sessionId: "cron", error });
const at = (h: number) => new Date(2026, 9, 24, h, 0).getTime();

test("an urgent event at 03:00 with the digest off survives a restart and is announced when quiet hours end", async () => {
	config({ digest: false, quietHours: quiet, batchWindowMs: 3_600_000 });
	let t = at(3);
	const spoken: Notice[] = [];
	const start = () =>
		startWakeRouter(
			dir,
			(n) => void spoken.push(n),
			() => t,
		);

	stop = start();
	for (let i = 0; i < 3; i++) fail("security check failed"); // one held event, count 3
	await router().flush();
	expect(spoken).toHaveLength(0);
	const heldPath = join(dir, "wake-held.json");
	expect(statSync(heldPath).mode & 0o777).toBe(0o600);
	expect(() => readdirSync(join(dir, "digest"))).toThrow(); // digest off, and nothing dropped

	stop(); // the daemon restarts at 05:00, still quiet
	await Bun.sleep(5); // stop() flushes in the background: let it finish at the old time
	t = at(5);
	stop = start();
	await router().flush();
	expect(spoken).toHaveLength(0);
	fail("security check failed"); // a fourth, after the restart, joins the held event
	await router().flush();
	expect(spoken).toHaveLength(0);

	t = at(8); // quiet hours end
	await router().flush();
	expect(spoken.map((n) => [n.kind, n.count])).toEqual([["action", 4]]);
	expect(JSON.parse(readFileSync(heldPath, "utf8"))).toEqual([]);
	await router().flush();
	expect(spoken).toHaveLength(1); // announced once
});

test("a restart after quiet hours ended announces what was held", async () => {
	config({ digest: false, quietHours: quiet, batchWindowMs: 3_600_000 });
	let t = at(3);
	const spoken: Notice[] = [];
	const start = () =>
		startWakeRouter(
			dir,
			(n) => void spoken.push(n),
			() => t,
		);
	stop = start();
	fail("disk full");
	await router().flush();
	stop();
	await Bun.sleep(5);
	t = at(9);
	stop = start();
	await router().flush();
	expect(spoken.map((n) => [n.kind, n.count])).toEqual([["action", 1]]);
});

test("wake payload files: older than the age limit go, then the oldest beyond the cap", () => {
	const d = join(dir, "wake");
	mkdirSync(d, { recursive: true });
	const now = Date.UTC(2026, 9, 24);
	const day = 86_400_000;
	const make = (name: string, ageDays: number) => {
		const p = join(d, name);
		writeFileSync(p, "x");
		const s = (now - ageDays * day) / 1000;
		utimesSync(p, s, s);
	};
	make("old1.txt", 30);
	make("old2.txt", 8);
	make("fresh.txt", 1);
	expect(pruneWakeFiles(d, { payloadMaxAgeDays: 7, payloadMaxFiles: 500 }, now)).toBe(2);
	expect(readdirSync(d)).toEqual(["fresh.txt"]);
	// The cap: 12 newer files and the 1-day one; keep 5, and they are the newest.
	for (let i = 0; i < 12; i++) make(`n${String(i).padStart(2, "0")}.txt`, 6 - i / 4);
	expect(pruneWakeFiles(d, { payloadMaxAgeDays: 7, payloadMaxFiles: 5 }, now)).toBe(8);
	expect(readdirSync(d).sort()).toEqual(["fresh.txt", "n08.txt", "n09.txt", "n10.txt", "n11.txt"]);
});

test("stashing a cron result prunes through the settings", () => {
	config({ batchWindowMs: 3_600_000, payloadMaxFiles: 3 });
	stop = startWakeRouter(dir, () => {});
	for (let i = 0; i < 6; i++)
		bus.emit("tool:result", {
			sessionId: "cron",
			tool: "cron:webhook",
			output: { i },
			durationMs: 1,
		});
	expect(readdirSync(join(dir, "wake"))).toHaveLength(3);
});
