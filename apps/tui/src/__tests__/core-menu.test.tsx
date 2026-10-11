/** The `/` menu shows core commands only, in the real App (#3918 D9). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

test("bare / lists core commands; typing reaches the rest; /help all lists everything", async () => {
	const events = await runAppHarness(path.join(import.meta.dir, "core-menu.harness.tsx"));
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	const bare = String(events.find((e) => e.phase === "bare")?.screen ?? "");
	expect(bare).toContain("/model");
	expect(bare).toContain("/settings");
	expect(bare).toContain("/resume");
	expect(bare).not.toContain("more, keep typing");
	for (const novelty of ["/dj ", "/pet ", "/music ", "/kanban ", "/vercel "]) {
		expect(bare).not.toContain(novelty);
	}
	expect(events.find((e) => e.phase === "prefix")?.ok).toBeTrue();
	const help = String(events.find((e) => e.phase === "help")?.screen ?? "");
	expect(help).toContain("/help all");
	expect(help).not.toContain("DJ Eight");
	expect(events.find((e) => e.phase === "help-all")?.ok).toBeTrue();
}, 90000);
