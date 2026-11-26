/**
 * A fresh tab opens with one welcome line. The input under it already asks
 * "Type a command or ask a question...", so the line must name the thread and
 * stop there. Two questions in a row read as the app talking twice.
 */

import { describe, expect, test } from "bun:test";
import { NEW_THREAD_LINE } from "./new-thread-line.js";
import { IDLE_PLACEHOLDER } from "../components/command-input.js";

describe("fresh-thread welcome line", () => {
	test("names the thread with the infinity mark", () => {
		expect(NEW_THREAD_LINE).toBe("∞ New thread");
	});

	test("does not ask the question the input placeholder already asks", () => {
		expect(NEW_THREAD_LINE).not.toContain("?");
		expect(NEW_THREAD_LINE).not.toContain("What shall we work on");
		expect(IDLE_PLACEHOLDER).toContain("ask a question");
	});
});
