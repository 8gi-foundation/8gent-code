import { describe, expect, test } from "bun:test";
import { keysUpTitleText } from "../KeysUpTitleRow.js";

describe("keysUpTitleText (#4967)", () => {
	test("brand, version and branch on one row when they fit", () => {
		expect(keysUpTitleText("0.20.28", "main", 52)).toBe("8gent v0.20.28  ⎇ main");
	});
	test("the branch gives way before the brand does", () => {
		expect(keysUpTitleText("0.20.28", "feat/a-very-long-branch-name", 20)).toBe("8gent v0.20.28");
	});
	test("no version, no branch", () => {
		expect(keysUpTitleText(undefined, "", 40)).toBe("8gent");
	});
});
