import { describe, expect, test } from "bun:test";
import { BUILT_IN_SLASH_COMMANDS } from "./slash-commands";
import { knownSlashNames, voiceTranscriptText } from "./voice-transcript";

describe("the transcript the input receives (#4949)", () => {
	test("the real built-in commands and their aliases are known", () => {
		const known = knownSlashNames();
		for (const c of BUILT_IN_SLASH_COMMANDS) {
			expect(known.has(c.name)).toBe(true);
			for (const a of c.aliases) expect(known.has(a.toLowerCase())).toBe(true);
		}
		expect(known.has("dj")).toBe(true);
		expect(known.has("help")).toBe(true);
	});

	test("saying slash dj play lofi types /dj play lofi", () => {
		expect(voiceTranscriptText("slash dj play lofi")).toBe("/dj play lofi");
		expect(voiceTranscriptText("Slash, DJ play lofi.")).toBe("/dj play lofi");
	});

	test("prose passes through unchanged", () => {
		expect(voiceTranscriptText("cut and slash prices")).toBe("cut and slash prices");
	});
});
