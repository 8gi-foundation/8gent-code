/**
 * The / menu fits the terminal in the real App, at 12 and 18 rows, and
 * Up/Down still reach every core command (#3918 D9, 8PO).
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { slashMenuVisibleRows } from "../components/command-input.js";
import { CORE_SLASH_COMMANDS } from "../lib/slash-commands.js";
import { runAppHarness } from "./app-driver.js";

for (const rows of [12, 18]) {
	test(`at ${rows} rows a bare / fits inside the frame and scrolls to every row`, async () => {
		const events = await runAppHarness(
			path.join(import.meta.dir, "slash-menu-height.harness.tsx"),
			{
				SHELL_ROWS: String(rows),
			},
		);
		// On failure the harness's message carries the last frame it saw.
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const frame = String(events.find((e) => e.phase === "open")?.frame ?? "");
		const lines = frame.split("\n");
		const visible = slashMenuVisibleRows(rows);
		// The input, the visible rows and the position line, all above the
		// frame's bottom border, and the footer still on the last line.
		const input = lines.findIndex((l) => l.includes("❯ /"));
		const bottom = lines.findIndex((l) => l.startsWith("└"));
		expect(input).toBeGreaterThan(0);
		expect(bottom).toBeGreaterThan(input);
		const inside = lines.slice(input + 1, bottom).join("\n");
		expect((inside.match(/(?:> | {2})\/[a-z-]+ /g) ?? []).length).toBe(visible);
		expect(inside).toContain(`1-${visible} of 14, Up/Down to scroll`);
		expect(lines[bottom]).not.toMatch(/\/[a-z]/);
		expect(lines.at(-1)).toContain("[^C] quit");
		expect(lines.length).toBeLessThanOrEqual(rows);

		const scroll = events.find((e) => e.phase === "scroll") as {
			seen: string[];
			last: string;
			top: string;
		};
		expect(scroll.seen).toHaveLength(CORE_SLASH_COMMANDS.size);
		expect(new Set(scroll.seen)).toEqual(new Set(CORE_SLASH_COMMANDS));
		expect(scroll.last).toBe("skills");
		expect(scroll.top).toBe("clear");
	}, 60000);
}
