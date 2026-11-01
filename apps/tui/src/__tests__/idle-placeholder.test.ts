import { expect, test } from "bun:test";
import { idlePlaceholder } from "../components/command-input.js";

// The input row spends 5 cells on the box edge, padding and the chevron; at 40
// columns the placeholder must fit the rest on one row, or the box grows a row.
test("the idle placeholder fits one row at 40 columns and keeps its wording at 100", () => {
	expect(idlePlaceholder(40).length).toBeLessThanOrEqual(40 - 9);
	expect(idlePlaceholder(40)).toContain("/");
	expect(idlePlaceholder(100)).toBe("Type a command or ask a question...");
});
