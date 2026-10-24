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
	test("an unknown word after slash is prose: no slash is typed", () => {
		expect(s("slash banana split")).toBe("slash banana split");
		expect(s("Slash prices by ten percent.")).toBe("Slash prices by ten percent.");
		expect(s("Slash, prices by ten percent")).toBe("Slash, prices by ten percent");
	});
	test("a command only counts when it is the word right after slash", () => {
		expect(s("slash the dj budget")).toBe("slash the dj budget");
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
	test("a full stop after prose is left alone", () => {
		expect(s("slash banana split.")).toBe("slash banana split.");
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

describe("one-letter commands never trigger", () => {
	// The caller leaves one-letter aliases out of the known set (voice-transcript.ts); the function
	// itself also refuses them, so a caller that forgets cannot make "slash c is fine" run /c.
	const withShort = new Set(["c", "h", "k", "dj", "clear"]);
	test("start and mid-sentence", () => {
		expect(spokenSlash("Slash c is fine", withShort)).toBe("Slash c is fine");
		expect(spokenSlash("Fine. Slash c is fine", withShort)).toBe("Fine. Slash c is fine");
		expect(spokenSlash("slash h", withShort)).toBe("slash h");
	});
	test("a longer command still works", () => {
		expect(spokenSlash("slash clear", withShort)).toBe("/clear");
	});
});

describe("when nothing is known", () => {
	test("no known set: only a lone slash is typed", () => {
		expect(spokenSlash("slash dj play")).toBe("slash dj play");
		expect(spokenSlash("slash Foo bar", new Set())).toBe("slash Foo bar");
		expect(spokenSlash("slash", new Set())).toBe("/");
	});
});

describe("skills and user commands count as known", () => {
	test("the caller's set decides", () => {
		const k = new Set(["dj", "deploy-check", "skill:review"]);
		expect(spokenSlash("slash deploy-check now", k)).toBe("/deploy-check now");
		expect(spokenSlash("slash Review", new Set(["review"]))).toBe("/review");
		expect(spokenSlash("slash review", k)).toBe("slash review");
	});
});
