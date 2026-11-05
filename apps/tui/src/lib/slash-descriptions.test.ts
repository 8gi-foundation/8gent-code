import { describe, expect, test } from "bun:test";
import { BUILT_IN_SLASH_COMMANDS, CORE_SLASH_COMMANDS } from "./slash-commands.js";

// The bare "/" menu at 80 columns fits "/name description" in about 70 cells; past that
// the row ends in an ellipsis in the middle of a sentence (walk of 1 Nov 2026).
const ROW_BUDGET = 66;

describe("core slash menu copy", () => {
	const core = BUILT_IN_SLASH_COMMANDS.filter((c) => CORE_SLASH_COMMANDS.has(c.name));

	test("every core command is in the table", () => {
		expect(core.length).toBe(CORE_SLASH_COMMANDS.size);
	});

	test("each row fits an 80 column menu without an ellipsis", () => {
		for (const c of core) {
			const row = `/${c.name} ${c.description}`;
			expect(row.length).toBeLessThanOrEqual(ROW_BUDGET);
		}
	});

	test("no row repeats the menu's own scroll hint", () => {
		for (const c of core) expect(c.description).not.toContain("↑↓");
	});

});
