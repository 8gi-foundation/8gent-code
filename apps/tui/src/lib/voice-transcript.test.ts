import { afterEach, describe, expect, test } from "bun:test";
import { BUILT_IN_SLASH_COMMANDS } from "./slash-commands";
import {
	knownSlashNames,
	refreshSlashNames,
	resetSlashNamesForTests,
	voiceTranscriptText,
	voiceTranscriptTextWith,
} from "./voice-transcript";

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

describe("the registry scan is off the transcript path", () => {
	afterEach(() => resetSlashNamesForTests());

	test("the transform is synchronous and never waits on a scan, even a hung one", async () => {
		resetSlashNamesForTests();
		const hung = refreshSlashNames(() => new Promise<string[]>(() => {}), 60_000);
		const t0 = Date.now();
		const out = voiceTranscriptText("slash dj play lofi");
		expect(out).toBe("/dj play lofi");
		expect(typeof out).toBe("string");
		expect(Date.now() - t0).toBeLessThan(50);
		void hung;
	});

	test("a hung scan is abandoned at the timeout and the next refresh can run", async () => {
		resetSlashNamesForTests();
		await refreshSlashNames(() => new Promise<string[]>(() => {}), 40);
		expect(voiceTranscriptText("slash deploy-check now")).toBe("slash deploy-check now");
		await refreshSlashNames(async () => ["/deploy-check"], 1000);
		expect(voiceTranscriptText("slash deploy-check now")).toBe("/deploy-check now");
	});

	test("two transcripts around a refresh keep their order: each is computed when it arrives", async () => {
		resetSlashNamesForTests();
		let release: (t: string[]) => void = () => {};
		const scan = refreshSlashNames(() => new Promise<string[]>((r) => (release = r)), 5000);
		const results: string[] = [];
		results.push(voiceTranscriptText("slash deploy-check first"));
		release(["/deploy-check"]);
		await scan;
		results.push(voiceTranscriptText("slash deploy-check second"));
		// The earlier transcript was answered at once and is not rewritten later.
		expect(results).toEqual(["slash deploy-check first", "/deploy-check second"]);
	});

	test("only one scan runs at a time", async () => {
		resetSlashNamesForTests();
		let calls = 0;
		let release: (t: string[]) => void = () => {};
		const load = () => {
			calls++;
			return new Promise<string[]>((r) => (release = r));
		};
		const a = refreshSlashNames(load, 5000);
		const b = refreshSlashNames(load, 5000);
		expect(calls).toBe(1);
		release([]);
		await Promise.all([a, b]);
		expect(calls).toBe(1);
	});

	test("a failed scan keeps the names already cached", async () => {
		resetSlashNamesForTests();
		await refreshSlashNames(async () => ["/deploy-check"], 1000);
		await refreshSlashNames(async () => {
			throw new Error("disk");
		}, 1000);
		expect(voiceTranscriptText("slash deploy-check now")).toBe("/deploy-check now");
	});
});
