import { describe, expect, test } from "bun:test";
import { BUILT_IN_SLASH_COMMANDS } from "./slash-commands";
import { knownSlashNames, voiceTranscriptText, voiceTranscriptTextWith } from "./voice-transcript";

describe("the transcript the input receives (#4949)", () => {
	test("the real built-in commands and their aliases are known", () => {
		const known = knownSlashNames();
		for (const c of BUILT_IN_SLASH_COMMANDS) {
			expect(known.has(c.name)).toBe(true);
			for (const a of c.aliases) if (a.length > 1) expect(known.has(a.toLowerCase())).toBe(true);
		}
		expect(known.has("dj")).toBe(true);
		expect(known.has("help")).toBe(true);
	});

	test("saying slash dj play lofi types /dj play lofi", () => {
		expect(voiceTranscriptText("slash dj play lofi")).toBe("/dj play lofi");
		expect(voiceTranscriptText("Slash, DJ play lofi.")).toBe("/dj play lofi");
	});

	test("one-letter aliases are never known, so 'slash c is fine' stays prose", () => {
		const known = knownSlashNames();
		for (const n of known) expect(n.length).toBeGreaterThan(1);
		expect(voiceTranscriptText("Slash c is fine")).toBe("Slash c is fine");
		expect(voiceTranscriptText("Okay. Slash k is the board")).toBe("Okay. Slash k is the board");
	});

	test("prose after slash at the start is not a command", () => {
		expect(voiceTranscriptText("Slash prices by ten percent.")).toBe(
			"Slash prices by ten percent.",
		);
	});

	test("skills and user prompt commands from the registry are known", () => {
		const text = (t: string) =>
			voiceTranscriptTextWith(t, ["/deploy-check", "/skill:review", "/x", "/Ship-It"]);
		expect(text("slash deploy-check now")).toBe("/deploy-check now");
		expect(text("Slash Ship-It please.")).toBe("/ship-it please");
		expect(text("slash x marks the spot")).toBe("slash x marks the spot");
		expect(text("slash dj play lofi")).toBe("/dj play lofi");
	});

	test("prose passes through unchanged", () => {
		expect(voiceTranscriptText("cut and slash prices")).toBe("cut and slash prices");
	});
});
