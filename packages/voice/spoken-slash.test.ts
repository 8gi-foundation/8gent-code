/**
 * Spoken "slash" types "/" so slash commands can be voice typed (#4949). Pure: the caller passes
 * the known command names, so no test needs the TUI.
 */
import { describe, expect, test } from "bun:test";
import { spokenSlash } from "./spoken-slash";

const KNOWN = new Set(["dj", "help", "voice", "model", "goal"]);
const s = (t: string) => spokenSlash(t, KNOWN);

describe("slash at the start", () => {
	test("slash dj play lofi types /dj play lofi", () => {
		expect(s("slash dj play lofi")).toBe("/dj play lofi");
	});
	test("the space after slash is dropped, extra spaces too", () => {
		expect(s("slash   help")).toBe("/help");
		expect(s("  slash help")).toBe("/help");
	});
	test("a lone slash is a lone /", () => {
		expect(s("slash")).toBe("/");
		expect(s("Slash.")).toBe("/");
	});
	test("an unknown word after slash still gets the slash (the menu filters it)", () => {
		expect(s("slash banana split")).toBe("/banana split");
	});
});

describe("case", () => {
	test("Slash and SLASH both work", () => {
		expect(s("Slash dj play lofi")).toBe("/dj play lofi");
		expect(s("SLASH dj play lofi")).toBe("/dj play lofi");
	});
	test("a known command name is lowercased", () => {
		expect(s("Slash DJ play Lofi")).toBe("/dj play Lofi");
		expect(s("slash Voice on")).toBe("/voice on");
	});
	test("an unknown first word keeps its case", () => {
		expect(s("slash Banana split")).toBe("/Banana split");
	});
	test("the arguments are never touched", () => {
		expect(s("slash goal Ship The Thing")).toBe("/goal Ship The Thing");
	});
});

describe("punctuation from the transcriber", () => {
	test("a comma or period after slash is dropped", () => {
		expect(s("Slash, dj play lofi")).toBe("/dj play lofi");
		expect(s("Slash. dj play lofi")).toBe("/dj play lofi");
		expect(s("slash... help")).toBe("/help");
	});
	test("the sentence full stop after a recognised command line is dropped", () => {
		expect(s("Slash, help.")).toBe("/help");
		expect(s("Slash dj play lofi.")).toBe("/dj play lofi");
	});
	test("a full stop after an unknown command line is left alone", () => {
		expect(s("slash banana split.")).toBe("/banana split.");
	});
	test("'slash' glued to punctuation inside a word is not a command", () => {
		expect(s("slashing prices")).toBe("slashing prices");
		expect(s("slashdot is down")).toBe("slashdot is down");
	});
});

describe("prose is untouched", () => {
	test.each([
		"cut and slash prices",
		"We should slash the budget",
		"use a forward slash here",
		"the slash key is next to shift",
		"he said slash and burn",
		"Hello. I would slash prices.",
		"",
		"   ",
	])("%j", (t) => {
		expect(s(t)).toBe(t);
	});
});

describe("slash opening a new command mid-utterance", () => {
	test("after a sentence end, when the next word is a known command", () => {
		expect(s("Do that first. Slash dj play lofi")).toBe("Do that first. /dj play lofi");
		expect(s("Okay! slash help")).toBe("Okay! /help");
		expect(s("Wait? Slash, voice on")).toBe("Wait? /voice on");
	});
	test("after a sentence end but not a known command: prose, untouched", () => {
		expect(s("I disagree. Slash prices by ten percent")).toBe(
			"I disagree. Slash prices by ten percent",
		);
	});
	test("with no sentence end before it: prose, untouched", () => {
		expect(s("then slash dj play lofi")).toBe("then slash dj play lofi");
	});
});

describe("when the whole thing is not a command", () => {
	test("nothing known: start rule still applies, but no case change", () => {
		expect(spokenSlash("slash Foo bar", new Set())).toBe("/Foo bar");
	});
	test("no known list at all is fine", () => {
		expect(spokenSlash("slash dj play")).toBe("/dj play");
	});
});
