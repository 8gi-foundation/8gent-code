/** A user theme file appears in the real App's /theme picker (Pi parity N1). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

test("/theme picker lists a valid user theme and not a broken one", async () => {
	const events = await runAppHarness(path.join(import.meta.dir, "theme-user.harness.tsx"), process.env.THEME_CAST ? { THEME_CAST: process.env.THEME_CAST } : {});
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	const picker = events.find((e) => e.phase === "picker");
	expect(picker?.listed).toBeTrue();
	expect(picker?.description).toBeTrue();
	expect(picker?.brokenListed).toBeFalse();
	const picked = events.find((e) => e.phase === "picked");
	expect(picked?.applied).toBeTrue();
	expect(picked?.error).toBeFalse();
	expect(picked?.userTheme).toBe("ember");
	expect(picked?.designSystem).toBeNull();
	const text = events.find((e) => e.phase === "text");
	expect(text?.applied).toBeTrue();
	expect(text?.userTheme).toBe("ember");
	expect(events.find((e) => e.phase === "reload")?.mentionsBroken).toBeTrue();
}, 90000);
