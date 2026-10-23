/**
 * A notice appears once per event (#4807). On a phone the resume line showed
 * five times and the Android voice line twice: notices made in the same
 * millisecond shared a React key, so the list drew one of them repeatedly.
 * Run in the real App on a coarse clock, resumed from a saved session.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

test("the resume notice and the Android voice line each show once", async () => {
	const events = await runAppHarness(
		path.join(import.meta.dir, "once-notices.harness.tsx"),
		{ TERMUX_VERSION: "0.118" },
		100_000,
	);
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	const at = (phase: string) => events.find((e) => e.phase === phase);

	expect(at("resume")?.seen).toBe(1);
	// Switching tabs and back must not copy it.
	expect(at("tabs")?.seen).toBe(1);
	expect(at("voice-on")?.enabled).toBe(1);
	expect(at("voice-on")?.hints).toBe(1);
}, 120_000);
