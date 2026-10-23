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

// ── 8SO review of #4888 ──────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { MAX_HELD } from "./wake-router";
import { readWakeSettings } from "./wake-wiring";

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

test("a prune limit of zero, a negative, NaN or a string never deletes everything", () => {
	for (const bad of [0, -1, -999, Number.NaN, "7", null, Number.POSITIVE_INFINITY]) {
		config({ payloadMaxFiles: bad, payloadMaxAgeDays: bad });
		const s = readWakeSettings(dir);
		expect(s.payloadMaxFiles).toBeGreaterThanOrEqual(1);
		expect(s.payloadMaxAgeDays).toBeGreaterThan(0);
	}
	// the pruner itself, called with the bad numbers directly
	const d = join(dir, "wake");
	mkdirSync(d, { recursive: true });
	for (const bad of [0, -1, Number.NaN]) {
		writeFileSync(join(d, "keep.txt"), "x");
		expect(
			pruneWakeFiles(d, { payloadMaxAgeDays: bad, payloadMaxFiles: bad }, Date.now() + 1000),
		).toBe(0);
		expect(existsSync(join(d, "keep.txt"))).toBe(true);
	}
});

test("a stashed payload survives its own prune, and a held event's payload is never removed", async () => {
	config({ batchWindowMs: 3_600_000, payloadMaxFiles: 1, quietHours: quiet, digest: false });
	const t = at(3);
	stop = startWakeRouter(
		dir,
		() => {},
		() => t,
	);
	fail("first urgent"); // held, with a payload file
	await router().flush();
	const held = JSON.parse(readFileSync(join(dir, "wake-held.json"), "utf8"));
	const heldPayload = held[0].event.payloadPath as string;
	for (let i = 0; i < 5; i++)
		bus.emit("tool:result", {
			sessionId: "cron",
			tool: "cron:webhook",
			output: { i },
			durationMs: 1,
		});
	expect(existsSync(heldPayload)).toBe(true);
});

test("a link in the wake folder is not followed by the prune, and a planted link is not written through", () => {
	const d = join(dir, "wake");
	mkdirSync(d, { recursive: true });
	const victim = join(dir, "victim.txt");
	writeFileSync(victim, "precious");
	utimesSync(victim, 1, 1);
	symlinkSync(victim, join(d, "link.txt"));
	pruneWakeFiles(d, { payloadMaxAgeDays: 1, payloadMaxFiles: 1 }, Date.now());
	expect(readFileSync(victim, "utf8")).toBe("precious");
	// a link planted at the name a payload will take
	config({ batchWindowMs: 3_600_000 });
	const text = JSON.stringify({ planted: 1 });
	symlinkSync(victim, join(d, `${sha16(text)}.txt`));
	stop = startWakeRouter(dir, () => {});
	bus.emit("tool:result", {
		sessionId: "cron",
		tool: "cron:webhook",
		output: { planted: 1 },
		durationMs: 1,
	});
	expect(readFileSync(victim, "utf8")).toBe("precious");
	expect(lstatSync(join(d, `${sha16(text)}.txt`)).isSymbolicLink()).toBe(false);
});

test("a flood of distinct urgent events is held up to a cap, the rest counted, and all announced", async () => {
	config({ digest: false, quietHours: quiet, batchWindowMs: 3_600_000, payloadMaxFiles: 100_000 });
	let t = at(3);
	const spoken: Notice[] = [];
	stop = startWakeRouter(
		dir,
		(n) => void spoken.push(n),
		() => t,
	);
	for (let i = 0; i < MAX_HELD + 60; i++) fail(`distinct failure ${i}`);
	await router().flush();
	const rows = JSON.parse(readFileSync(join(dir, "wake-held.json"), "utf8"));
	expect(rows.filter((r: { event?: unknown }) => r.event)).toHaveLength(MAX_HELD);
	expect(rows.find((r: { overflow?: number }) => r.overflow)?.overflow).toBe(60);
	expect(statSync(join(dir, "wake-held.json")).size).toBeLessThan(500_000);
	t = at(8);
	await router().flush();
	expect(spoken).toHaveLength(MAX_HELD + 1);
	expect(spoken[spoken.length - 1]?.count).toBe(60);
});

test("a held file that is forged, linked, oversized or owned by someone else is not trusted", async () => {
	config({ digest: false, quietHours: quiet, batchWindowMs: 3_600_000 });
	const t = at(9); // quiet hours over: anything loaded is announced at once
	const wakeDir = join(dir, "wake");
	mkdirSync(wakeDir, { recursive: true });
	const good = {
		event: {
			source: "cron",
			priority: "urgent",
			dedupeKey: "cron:good",
			origin: "cron",
			payloadPath: join(wakeDir, "ok.txt"),
			at: 1,
		},
		count: 2,
	};
	const forged = (patch: object) => ({ ...good, event: { ...good.event, ...patch } });
	const rows = [
		good,
		forged({ dedupeKey: "k2", payloadPath: "/etc/passwd" }),
		forged({ dedupeKey: "k3", payloadPath: join(dir, "wake", "..", "config.json") }),
		forged({ dedupeKey: "k4", payloadPath: join(wakeDir, "x.sh") }),
		forged({ dedupeKey: "k5", priority: "owner" }),
		forged({ dedupeKey: "k6", source: "root" }),
		{ ...good, count: -5 },
		{ ...good, count: 1e12 },
		{ nonsense: true },
		null,
	];
	const heldPath = join(dir, "wake-held.json");
	const run = async () => {
		const spoken: Notice[] = [];
		stop = startWakeRouter(
			dir,
			(n) => void spoken.push(n),
			() => t,
		);
		await router().flush();
		stop();
		stop = null;
		await Bun.sleep(5);
		return spoken.map((n) => n.event.dedupeKey);
	};
	writeFileSync(heldPath, JSON.stringify(rows));
	expect(await run()).toEqual(["cron:good"]);
	// a link at the held file's name is never read
	const other = join(dir, "other.json");
	writeFileSync(other, JSON.stringify([good]));
	rmSync(heldPath, { force: true });
	symlinkSync(other, heldPath);
	expect(await run()).toEqual([]);
	// an oversized file is not read
	rmSync(heldPath, { force: true });
	writeFileSync(
		heldPath,
		JSON.stringify([good, ...Array.from({ length: 80_000 }, () => ({ pad: "x".repeat(40) }))]),
	);
	expect(await run()).toEqual([]);
});

test("the held file is replaced through a link planted at its name, never written through", async () => {
	config({ digest: false, quietHours: quiet, batchWindowMs: 3_600_000 });
	const victim = join(dir, "victim.txt");
	writeFileSync(victim, "precious");
	symlinkSync(victim, join(dir, "wake-held.json"));
	const t = at(3);
	stop = startWakeRouter(
		dir,
		() => {},
		() => t,
	);
	fail("held while a link sits at the name");
	await router().flush();
	expect(readFileSync(victim, "utf8")).toBe("precious");
	expect(lstatSync(join(dir, "wake-held.json")).isFile()).toBe(true);
	expect(statSync(join(dir, "wake-held.json")).mode & 0o777).toBe(0o600);
});
