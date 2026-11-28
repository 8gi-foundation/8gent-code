import { describe, expect, test } from "bun:test";
import { IDLE_PLACEHOLDER } from "../components/command-input.js";
import { NEW_THREAD_LINE } from "./new-thread-line.js";

// The input below an empty thread already asks "Type a command or ask a
// question...". The divider at the top of the thread must not ask it again.
describe("new thread divider", () => {
	test("names the thread and does not repeat the input's question", () => {
		expect(NEW_THREAD_LINE).toBe("∞ New thread");
		expect(NEW_THREAD_LINE).not.toContain("What shall we work on");
		expect(NEW_THREAD_LINE).not.toContain("?");
		expect(IDLE_PLACEHOLDER).toContain("ask a question");
	});
});
