/** `@` file mention in the real App (#3918 D2). */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

test("@ lists matching files; Tab inserts the picked one; Down picks the next", async () => {
	const events = await runAppHarness(path.join(import.meta.dir, "at-mention.harness.tsx"));
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	const { first, second } = events.find((e) => e.phase === "inserted") as {
		first: string;
		second: string;
	};
	expect(first).toMatch(/file-mention\.ts$/);
	expect(second).toMatch(/file-mention\.test\.ts$/);
	// The paths are real, relative to where the TUI runs.
	for (const p of [first, second]) expect(fs.existsSync(path.resolve(process.cwd(), p))).toBeTrue();
}, 90000);

test("outside git the @ list walks the folder and reloads when a mention opens", async () => {
	const events = await runAppHarness(path.join(import.meta.dir, "at-mention-refresh.harness.tsx"));
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	expect(events.find((e) => e.phase === "refresh")?.ok).toBeTrue();
}, 90000);
