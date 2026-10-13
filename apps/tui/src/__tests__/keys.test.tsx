/** Ctrl+L model switch and /hotkeys in the real App (#3918). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

test("Ctrl+L switches the model, /hotkeys lists keys", async () => {
	const events = await runAppHarness(path.join(import.meta.dir, "keys.harness.tsx"));
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	expect(events.find((e) => e.phase === "ctrl-l")?.line).toBe("Model switched to: shell-test:1b");
	expect(events.find((e) => e.phase === "slash-model")?.ok).toBeTrue();
	const hotkeys = String(events.find((e) => e.phase === "hotkeys")?.screen ?? "");
	expect(hotkeys).toContain("Ctrl+L");
	expect(hotkeys).toContain("Model picker");
}, 90000);
