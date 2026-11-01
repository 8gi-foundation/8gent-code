/**
 * Tests for the shared voice grammar (issue #2759 step 5).
 *
 * Two properties matter most and are tested hardest:
 *   1. Precision on lifecycle verbs — "approve" the bare word is a command,
 *      but "approve the change in auth.ts" is dictation. A false positive here
 *      ships or kills real work.
 *   2. Dictation is the safe fallback — anything not a deliberate command must
 *      come back as `dictate` with the text intact.
 */

import { describe, expect, test } from "bun:test";
import {
	normalizeTranscript,
	parseVoiceCommand,
	stripWakeWord,
	VOICE_COMMAND_HELP,
	type VoiceIntent,
} from "./voice-grammar";

describe("normalizeTranscript", () => {
	test("lowercases, trims, collapses whitespace", () => {
		expect(normalizeTranscript("  Approve   The  Plan ")).toBe("approve the plan");
	});

	test("strips trailing sentence punctuation", () => {
		expect(normalizeTranscript("dispatch it!")).toBe("dispatch it");
		expect(normalizeTranscript("merge?")).toBe("merge");
	});

	test("strips whisper non-speech markers", () => {
		expect(normalizeTranscript("[BLANK_AUDIO]")).toBe("");
		expect(normalizeTranscript("approve [ Silence ]")).toBe("approve");
		expect(normalizeTranscript("(music) send it *laughs*")).toBe("send it");
	});
});

describe("parseVoiceCommand - bare lifecycle commands fire", () => {
	const cases: [string, VoiceIntent][] = [
		["approve", "approve"],
		["Approve it.", "approve"],
		["yes", "approve"],
		["lgtm", "approve"],
		["reject", "reject"],
		["no", "reject"],
		["dispatch", "dispatch"],
		["ship it", "dispatch"],
		["merge", "merge"],
		["land it", "merge"],
		["stop", "stop"],
		["abort mission", "stop"],
		["send it", "submit"],
		["scratch that", "scratch"],
		["undo", "undo_word"],
		["new line", "newline"],
		["help", "help"],
		["repeat", "repeat"],
		["cancel", "cancel"],
	];

	for (const [utterance, intent] of cases) {
		test(`"${utterance}" -> ${intent}`, () => {
			const cmd = parseVoiceCommand(utterance);
			expect(cmd.intent).toBe(intent);
			expect(cmd.isCommand).toBe(true);
			expect(cmd.confidence).toBeGreaterThan(0.9);
		});
	}
});

describe("parseVoiceCommand - precision: verbs inside dictation are NOT commands", () => {
	const dictations = [
		"approve the change in auth dot ts and then run the tests",
		"can you dispatch a worker to refactor the parser module",
		"merge the two config files into one and remove the duplicate keys",
		"stop the server before you rebuild the docker image",
		"the build broke so reject that approach and try again",
	];

	for (const utterance of dictations) {
		test(`"${utterance.slice(0, 32)}..." -> dictate`, () => {
			const cmd = parseVoiceCommand(utterance);
			expect(cmd.intent).toBe("dictate");
			expect(cmd.isCommand).toBe(false);
			expect(cmd.arg).toBe(normalizeTranscript(utterance));
		});
	}
});

describe("parseVoiceCommand - steer carries an argument", () => {
	test("steer with a correction", () => {
		const cmd = parseVoiceCommand("steer use the other endpoint instead");
		expect(cmd.intent).toBe("steer");
		expect(cmd.arg).toBe("use the other endpoint instead");
		expect(cmd.isCommand).toBe(true);
	});

	test("colon and comma separators are stripped", () => {
		expect(parseVoiceCommand("steer: keep the old API").arg).toBe("keep the old api");
		expect(parseVoiceCommand("actually, use postgres").arg).toBe("use postgres");
	});

	test("a bare steer with no correction is not a command", () => {
		const cmd = parseVoiceCommand("steer");
		// "steer" alone carries no instruction, so it falls through to dictation.
		expect(cmd.intent).toBe("dictate");
	});
});

describe("parseVoiceCommand - empty / silence", () => {
	test("empty string cancels", () => {
		expect(parseVoiceCommand("").intent).toBe("cancel");
	});

	test("pure non-speech marker cancels", () => {
		expect(parseVoiceCommand("[BLANK_AUDIO]").intent).toBe("cancel");
	});
});

describe("parseVoiceCommand - default dictation", () => {
	test("ordinary prose is dictation with text preserved", () => {
		const cmd = parseVoiceCommand("add a retry with exponential backoff to the fetch helper");
		expect(cmd.intent).toBe("dictate");
		expect(cmd.arg).toBe("add a retry with exponential backoff to the fetch helper");
		expect(cmd.confidence).toBe(1);
	});
});

describe("stripWakeWord", () => {
	test("bare wake word arms listening (empty remainder)", () => {
		expect(stripWakeWord("hey eight")).toBe("");
		expect(stripWakeWord("Hey Eight.")).toBe("");
	});

	test("wake word plus command returns the remainder", () => {
		expect(stripWakeWord("hey eight, dispatch")).toBe("dispatch");
		expect(stripWakeWord("hey agent approve the plan")).toBe("approve the plan");
	});

	test("common mishears are accepted", () => {
		expect(stripWakeWord("hey ate merge")).toBe("merge");
		expect(stripWakeWord("okay eight stop")).toBe("stop");
	});

	test("no wake word returns null", () => {
		expect(stripWakeWord("dispatch the plan")).toBeNull();
		expect(stripWakeWord("")).toBeNull();
	});

	test("caller can supply extra variants", () => {
		expect(stripWakeWord("computer, dispatch", ["computer"])).toBe("dispatch");
	});
});

describe("wake-word + grammar compose end to end", () => {
	test("hey eight -> approve flows through the parser", () => {
		const remainder = stripWakeWord("hey eight approve");
		expect(remainder).not.toBeNull();
		const cmd = parseVoiceCommand(remainder as string);
		expect(cmd.intent).toBe("approve");
	});
});

describe("VOICE_COMMAND_HELP is coherent with the grammar", () => {
	test("every listed 'say' phrase resolves to a command (not dictation)", () => {
		for (const entry of VOICE_COMMAND_HELP) {
			// Strip the "<correction>" placeholder for the argument-carrying steer.
			const say = entry.say.replace(/<[^>]+>/g, "an example correction").trim();
			const cmd = parseVoiceCommand(say);
			expect(cmd.isCommand).toBe(true);
		}
	});
});
