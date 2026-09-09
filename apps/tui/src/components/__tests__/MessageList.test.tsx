/**
 * MessageList system-message rendering (#2922 chat manners).
 *
 * Headless Ink render (real reconciler, fake stdout, debug frames) so the
 * assertions read the ACTUAL terminal rows, not the element tree. The bug
 * this guards: when the slice overflowed the pane, Yoga shrank every block
 * and the bottom "───" of a system message was painted on the same row as
 * the line of text beneath it, eating its first three characters
 * ("───itHub: not detected", "───eration interrupted.").
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Box, render } from "ink";
import React from "react";
import type { Message } from "../../app.js";
import { MessageList, estimateMessageRows, wrappedRows } from "../message-list.js";

class FakeStdout extends EventEmitter {
	columns = 120;
	rows = 40;
	isTTY = true;
	frames: string[] = [];
	write = (frame: string): boolean => {
		this.frames.push(frame);
		return true;
	};
	lastFrame(): string {
		return this.frames.at(-1) ?? "";
	}
}

class FakeStdin extends EventEmitter {
	isTTY = true;
	setEncoding(): this {
		return this;
	}
	setRawMode(): this {
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
	read(): null {
		return null;
	}
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * Render the list into a fixed pane (width x height, overflow hidden, the
 * shape app.tsx gives it) and return the visible rows with trailing
 * whitespace removed. `rowBudget` is deliberately generous so the test
 * proves the measured pane height, not the caller's guess, bounds the slice.
 */
async function renderRows(
	messages: Message[],
	width: number,
	height = 30,
	rowBudget = 100,
): Promise<string[]> {
	const stdout = new FakeStdout();
	const stdin = new FakeStdin();
	const instance = render(
		<Box width={width} height={height} flexDirection="column" overflow="hidden">
			<MessageList
				messages={messages}
				contentWidth={width}
				rowBudget={rowBudget}
				showAnimations={false}
				animateTyping={false}
				scrollEnabled={false}
			/>
		</Box>,
		{
			stdout: stdout as unknown as NodeJS.WriteStream,
			stdin: stdin as unknown as NodeJS.ReadStream,
			debug: true,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	// Let effects (FadeIn timers, the pane measurement) settle before reading.
	await new Promise((r) => setTimeout(r, 120));
	const rows = stdout
		.lastFrame()
		.replace(ANSI, "")
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""));
	instance.unmount();
	return rows;
}

const at = new Date("2026-09-07T22:00:00Z");
const msg = (id: string, role: Message["role"], content: string): Message => ({
	id,
	role,
	content,
	timestamp: at,
});

const SEPARATOR = "───";

/** Every row that carries a separator carries nothing else. */
function expectSeparatorsOwnTheirRows(rows: string[]): void {
	for (const row of rows) {
		if (row.includes(SEPARATOR)) expect(row.trim()).toBe(SEPARATOR);
	}
}

const STATUS =
	"Session Status:\n  Duration: 2:47\n  Tokens used: 0\n  Commands: 3\n  Branch: main\n  Animations: on\n  Sound: off";

const ONBOARDING =
	"Good day. I'm 8gent, The Infinite Gentleman.\n\nHere's what I detected from your environment:\n  Name: not detected\n  Email: not detected\n  GitHub: not detected\n  Provider: ollama";

describe("MessageList system messages: the divider owns its row", () => {
	test("a multi-line system message keeps every line intact at 24 columns", async () => {
		const rows = await renderRows(
			[msg("u1", "user", "Write a haiku about terminals"), msg("s1", "system", STATUS)],
			24,
		);
		const text = rows.join("\n");
		for (const line of STATUS.split("\n")) {
			expect(text).toContain(line.trim());
		}
		expectSeparatorsOwnTheirRows(rows);
		expect(rows.filter((r) => r.trim() === SEPARATOR)).toHaveLength(2);
	});

	test("a single-line system message wider than the hint budget wraps without losing characters", async () => {
		const rows = await renderRows(
			[
				msg("u1", "user", "Write a haiku about terminals"),
				msg("s1", "system", "Generation interrupted."),
			],
			24,
		);
		const text = rows.join(" ");
		expect(text).toContain("Generation");
		expect(text).toContain("interrupted.");
		expect(text).not.toContain("───eration");
		expectSeparatorsOwnTheirRows(rows);
	});

	test("the onboarding block renders GitHub with its first letters", async () => {
		const rows = await renderRows([msg("s1", "system", ONBOARDING)], 26);
		const text = rows.join("\n");
		expect(text).toContain("GitHub: not detected");
		expect(text).toContain("Provider: ollama");
		expect(text).not.toContain("───itHub");
		expectSeparatorsOwnTheirRows(rows);
	});

	test("a single message taller than the pane keeps its newest rows on screen (fr-04 shape)", async () => {
		// The onboarding block alone is taller than a 10-row pane. It cannot be
		// sliced, so the column anchors to the bottom: the detected values and
		// the closing rule are visible, and the overflow leaves off the top.
		const rows = await renderRows([msg("s1", "system", ONBOARDING)], 26, 10);
		const text = rows.join("\n");
		expect(text).toContain("GitHub: not detected");
		expect(text).toContain("Provider: ollama");
		expectSeparatorsOwnTheirRows(rows);
		expect(rows.filter((r) => r.trim() === SEPARATOR)).toHaveLength(1);
		expect(rows.filter((r) => r.length > 0).length).toBeLessThanOrEqual(10);
	});

	test("a pane shorter than the conversation clips whole messages, never squashes them (fr-09 shape)", async () => {
		// 120x40 with both rails open: the centre pane had 16 rows while
		// app.tsx asked for 30. Same shape here: a 16-row pane, a 100-row ask.
		const conversation = [
			msg("u1", "user", "In one short sentence, what can you help me with?"),
			msg("a1", "assistant", "Got it. Your name is saved, James. What are we building today?"),
			msg("u2", "user", "Write a haiku about terminals"),
			msg("s1", "system", "Generation interrupted."),
			msg("a2", "assistant", "The local model turn could not complete: The operation was aborted"),
		];
		const rows = await renderRows(conversation, 24, 16);
		const text = rows.join("\n");
		expectSeparatorsOwnTheirRows(rows);
		// The newest message is fully visible, down to its last word.
		expect(text).toContain("aborted");
		// Nothing painted past the pane.
		expect(rows.filter((r) => r.length > 0).length).toBeLessThanOrEqual(16);
	});
});

describe("estimateMessageRows matches what the list paints", () => {
	test("wrappedRows counts word-wrapped rows the way Ink does", () => {
		expect(wrappedRows("", 10)).toBe(0);
		expect(wrappedRows("Generation interrupted.", 22)).toBe(2);
		expect(
			wrappedRows("The local model turn could not complete: The operation was aborted", 15),
		).toBe(5);
		expect(wrappedRows("a\n\nb", 10)).toBe(3);
	});

	test("a system block counts both separators and its margin", () => {
		// "Generation interrupted." wraps to 2 rows at 22 cols: 1 + 2 + 1 + 1.
		expect(estimateMessageRows(msg("s", "system", "Generation interrupted."), 24)).toBe(5);
		// 7 lines, none wider than 22 cols: 1 + 7 + 1 + 1.
		expect(estimateMessageRows(msg("s", "system", STATUS), 24)).toBe(10);
		// A short hint is one centred row plus its margin.
		expect(estimateMessageRows(msg("s", "system", "Notes saved."), 24)).toBe(2);
	});

	test("counted rows equal painted rows for the fr-09 conversation", async () => {
		const conversation = [
			msg("u1", "user", "Write a haiku about terminals"),
			msg("s1", "system", "Generation interrupted."),
			msg("s2", "system", STATUS),
		];
		const counted = conversation.reduce((n, m) => n + estimateMessageRows(m, 24), 0);
		const rows = await renderRows(conversation, 24, 40);
		// Painted rows: everything up to and including the last non-empty row,
		// plus the final marginBottom row that follows it.
		let lastPainted = 0;
		rows.forEach((r, i) => {
			if (r.length > 0) lastPainted = i;
		});
		expect(lastPainted + 1 + 1).toBe(counted);
	});
});
