import { describe, expect, test } from "bun:test";
import {
	KNOWN_SUBCOMMANDS,
	normalizeSubcommand,
	suggestSubcommand,
	unknownSubcommandLines,
} from "./subcommand-match";

describe("subcommand matching", () => {
	test("a capitalised first word dispatches to the same subcommand", () => {
		expect(normalizeSubcommand("Keys")).toBe("keys");
		expect(KNOWN_SUBCOMMANDS).toContain(normalizeSubcommand("Keys") as never);
		expect(normalizeSubcommand(undefined)).toBeUndefined();
	});
	test("a near miss is suggested before the help hint", () => {
		expect(suggestSubcommand("kyes")).toBe("keys");
		expect(suggestSubcommand("Doctr")).toBe("doctor");
		expect(unknownSubcommandLines("kys")).toEqual([
			"Unknown command: kys",
			"Did you mean: 8gent keys?",
			"Run '8 --help' for usage information.",
		]);
	});
	test("a far miss gets no suggestion", () => {
		expect(suggestSubcommand("zzzzzzzz")).toBeNull();
		expect(unknownSubcommandLines("zzzzzzzz")).toHaveLength(2);
	});
});
