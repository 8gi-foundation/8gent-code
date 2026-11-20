import { describe, expect, test } from "bun:test";
import { voiceReplyText } from "./voice-reply";

describe("voiceReplyText (#154)", () => {
	test("an empty reply stays empty, never Done.", () => {
		expect(voiceReplyText("")).toBe("");
		expect(voiceReplyText(undefined)).toBe("");
		expect(voiceReplyText(null)).toBe("");
	});
	test("a reply of only markers stays empty", () => {
		expect(voiceReplyText("  [_EOT_] <|im_end|> ")).toBe("");
	});
	test("a real reply is kept, markers stripped", () => {
		expect(voiceReplyText("Hello there[_EOT_]")).toBe("Hello there");
	});
});
