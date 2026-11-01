import { describe, expect, test } from "bun:test";
import { VOICE_ACK, VOICE_ACK_MAX_WORDS, ackForTranscript, relevantAck } from "./voice-ack";

describe("relevant voice ack", () => {
	test("picks a phrase for the intent", () => {
		expect(relevantAck("what is the status of the pull request")).toBe(
			"Checking the PR status now",
		);
		expect(relevantAck("how did the last pilot run go")).toBe("Looking at the pilot run");
		expect(relevantAck("is CI green on main")).toBe("Checking the CI status now");
		expect(relevantAck("did the release go out")).toBe("Checking the release now");
		expect(relevantAck("can you fix the broken login")).toBe("Looking into that fix now");
	});
	test("empty, whitespace, sentinel and unmatched fall back to the generic ack", () => {
		expect(relevantAck("")).toBe(VOICE_ACK);
		expect(relevantAck("   ")).toBe(VOICE_ACK);
		expect(relevantAck(undefined)).toBe(VOICE_ACK);
		expect(
			relevantAck("[voice message received - transcription failed, please send as text]"),
		).toBe(VOICE_ACK);
		expect(relevantAck("umm okay thanks")).toBe(VOICE_ACK);
	});
	test("broad everyday words do not pick a wrong-topic phrase", () => {
		for (const p of [
			"post",
			"message",
			"look",
			"ci",
			"checks",
			"actions",
			"send a message to Sam",
			"take a look at this",
			"I will post it later",
			"check the actions we agreed",
			"what time is it",
			"no issue there",
			"the clock tick",
		]) {
			expect(relevantAck(p)).toBe(VOICE_ACK);
		}
	});
	test("never echoes the transcript", () => {
		expect(relevantAck("pull request for the secret project zebra")).not.toMatch(/zebra|secret/i);
	});
	test("length cap, no em dash, no banned words", () => {
		const probes = [
			"pr",
			"pilot",
			"ci",
			"release",
			"issue",
			"video",
			"bug",
			"status",
			"draft",
			"why",
			`ag${"ent"} pr`,
			"umm",
		];
		for (const p of [...probes, ""]) {
			const a = relevantAck(p);
			expect(a.split(/\s+/).length).toBeLessThanOrEqual(VOICE_ACK_MAX_WORDS);
			expect(a).not.toMatch(
				new RegExp(
					`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]|ag${"ent"}`,
					"i",
				),
			);
		}
	});
	test("timeout falls back to the generic ack without waiting for the transcript", async () => {
		const never = new Promise<string>(() => {});
		const t0 = Date.now();
		expect(await ackForTranscript(never, 40)).toBe(VOICE_ACK);
		expect(Date.now() - t0).toBeLessThan(500);
	});
	test("a transcript that arrives in time gives the relevant phrase", async () => {
		expect(await ackForTranscript(Promise.resolve("check the PR"), 500)).toBe(
			"Checking the PR status now",
		);
	});
	test("rejected, empty or missing transcript falls back", async () => {
		expect(await ackForTranscript(Promise.reject(new Error("x")), 500)).toBe(VOICE_ACK);
		expect(await ackForTranscript(Promise.resolve(""), 500)).toBe(VOICE_ACK);
		expect(await ackForTranscript(undefined)).toBe(VOICE_ACK);
	});
});
