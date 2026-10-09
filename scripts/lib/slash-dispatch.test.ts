import { describe, expect, test } from "bun:test";
import { findUndispatched } from "./slash-dispatch";

describe("findUndispatched", () => {
	test("finds a switch case", () => {
		expect(findUndispatched(["help"], [`case "help":`])).toEqual([]);
	});
	test("finds default-branch comparisons", () => {
		const src = `if (command === ("model" as any)) {} else if ((command as string) === "auth") {}`;
		expect(findUndispatched(["model", "auth"], [src])).toEqual([]);
	});
	test("finds in-component handlers via builtInName", () => {
		expect(findUndispatched(["goal"], [], [`resolved.entry.builtInName === "goal"`])).toEqual([]);
	});
	test("a plain switch case in a component source does not count", () => {
		expect(findUndispatched(["toolshed"], [], [`case "toolshed":`])).toEqual(["toolshed"]);
	});
	test("reports names with no handler anywhere", () => {
		expect(findUndispatched(["help", "sprite"], [`case "help":`])).toEqual(["sprite"]);
	});
	test("does not match a name that is a prefix of another", () => {
		expect(findUndispatched(["term"], [`command === ("terminal" as any)`])).toEqual(["term"]);
	});
});
