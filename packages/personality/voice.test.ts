/**
 * Pilot break 7: "Reply with just the word pong." came back as "pong" plus a
 * stapled tagline ("Another notch in the infinite belt."). A bare-reply
 * instruction must suppress the persona line; ordinary requests keep it.
 */
import { describe, expect, test } from "bun:test";
import { COMPLETION_PHRASES, flavorResponse, wantsBareReply } from "./voice";

describe("wantsBareReply", () => {
	const terse = [
		"Reply with just the word pong.",
		"Reply with just OK.",
		"What does README.md say? Answer in one line.",
		"Answer with only the commit sha",
		"respond in one word",
		"Give me the path, nothing else.",
		"Explain it in a single sentence",
		"Say yes or no, no preamble",
		"print only the number",
	];
	for (const msg of terse) {
		test(`terse: ${msg}`, () => expect(wantsBareReply(msg)).toBe(true));
	}

	const ordinary = [
		"Write a 1500 word essay about the history of the semicolon.",
		"hello, what is in this folder?",
		"Refactor the parser and add tests",
		"Which function did I ask you to add, and what commit sha did you report?",
		"",
	];
	for (const msg of ordinary) {
		test(`ordinary: ${msg || "(empty)"}`, () => expect(wantsBareReply(msg)).toBe(false));
	}
});

describe("flavorResponse", () => {
	test("still staples the suffix when a caller asks for flavor", () => {
		const out = flavorResponse("done", { style: "completion", suffix: COMPLETION_PHRASES[0] });
		expect(out).toBe(`done\n\n${COMPLETION_PHRASES[0]}`);
	});

	test("empty or whitespace-only content never gets a tagline", () => {
		const flavor = {
			style: "completion" as const,
			prefix: "Right away.",
			suffix: COMPLETION_PHRASES[0],
		};
		for (const empty of ["", " ", "\n\n", "\t \n"]) {
			expect(flavorResponse(empty, flavor)).toBe(empty);
		}
	});
});
