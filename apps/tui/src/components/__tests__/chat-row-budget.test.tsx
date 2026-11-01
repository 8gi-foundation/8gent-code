/**
 * #3019: the chat row budget was `viewport.height - 10`, far more rows than
 * the chat box actually has once the header, tabs, rails and input take
 * their share. MessageList admitted too many rows, Ink shrank the items and
 * lines overprinted each other. These tests render a real Ink tree into a
 * fake 80x45 terminal whose chrome leaves 13 chat rows, as in the issue.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Box, type DOMElement, Text, render } from "ink";
import { useRef } from "react";
import type { Message } from "../../app.js";
import { chatRowBudget, useMeasuredHeight } from "../../hooks/useMeasuredHeight.js";
import { MessageList } from "../message-list.js";

const COLS = 80;
const ROWS = 45;
const CHROME_TOP = 28; // header, tabs, rails: rows the chat never gets
const INPUT_ROWS = 4;
const CHAT_ROWS = ROWS - CHROME_TOP - INPUT_ROWS; // 13

const at = new Date("2026-09-29T16:21:00Z");

function fruitChat(): Message[] {
	const fruits = [
		"Apple",
		"Banana",
		"Cherry",
		"Damson",
		"Elderberry",
		"Fig",
		"Grape",
		"Huckleberry",
		"Kiwi",
		"Lemon",
		"Mango",
		"Nectarine",
	];
	return [
		{
			id: "u1",
			role: "user",
			content: "Without using any tools, list twelve fruits, one per line.",
			timestamp: at,
		},
		{ id: "a1", role: "assistant", content: fruits.join("\n"), timestamp: at },
		{ id: "u2", role: "user", content: "Now the last one again.", timestamp: at },
		{ id: "a2", role: "assistant", content: "Nectarine", timestamp: at },
	];
}

function Screen({ measured, messages }: { measured: boolean; messages: Message[] }) {
	const ref = useRef<DOMElement>(null);
	const rows = useMeasuredHeight(ref);
	const budget = measured ? chatRowBudget(rows, ROWS, false) : Math.max(6, ROWS - 10);
	return (
		<Box flexDirection="column" width={COLS} height={ROWS}>
			<Box flexShrink={0} height={CHROME_TOP} flexDirection="column">
				<Text>HEADER-TOP</Text>
				<Box flexGrow={1} />
				<Text>HEADER-BOTTOM</Text>
			</Box>
			<Box ref={ref} flexGrow={1} minHeight={0} flexDirection="column" overflow="hidden">
				<MessageList
					messages={messages}
					rowBudget={budget}
					contentWidth={COLS}
					scrollEnabled={false}
					showAnimations={false}
					animateTyping={false}
				/>
			</Box>
			<Box flexShrink={0} height={INPUT_ROWS}>
				<Text>INPUT-LINE</Text>
			</Box>
		</Box>
	);
}

function fakeStdout() {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = COLS;
	out.rows = ROWS;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(s);
		return true;
	};
	return out;
}

async function lastFrame(measured: boolean, messages: Message[] = fruitChat()): Promise<string[]> {
	const stdout = fakeStdout();
	const app = render(<Screen measured={measured} messages={messages} />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	await new Promise((r) => setTimeout(r, 50));
	app.unmount();
	const frame = stdout.frames.filter((f) => f.includes("INPUT-LINE")).at(-1) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
	return frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
}

describe("chatRowBudget", () => {
	test("measured height wins over the viewport guess", () => {
		expect(chatRowBudget(13, 45, false)).toBe(13);
		expect(chatRowBudget(13, 45, true)).toBe(13);
	});

	test("falls back to the viewport guess before the first layout", () => {
		expect(chatRowBudget(null, 45, false)).toBe(35);
		expect(chatRowBudget(null, 45, true)).toBe(27);
		expect(chatRowBudget(0, 45, false)).toBe(35);
	});

	test("never below four rows", () => {
		expect(chatRowBudget(2, 45, false)).toBe(4);
	});
});

describe("chat box at 80x45 with 13 chat rows (#3019)", () => {
	test("the chat box measures 13 rows", async () => {
		let seen = null as number | null;
		function Probe() {
			const ref = useRef<DOMElement>(null);
			seen = useMeasuredHeight(ref);
			return (
				<Box flexDirection="column" height={ROWS}>
					<Box flexShrink={0} height={CHROME_TOP} />
					<Box ref={ref} flexGrow={1} minHeight={0} overflow="hidden">
						<Text>chat</Text>
					</Box>
					<Box flexShrink={0} height={INPUT_ROWS} />
				</Box>
			);
		}
		const stdout = fakeStdout();
		const app = render(<Probe />, {
			stdout: stdout as unknown as NodeJS.WriteStream,
			debug: true,
			patchConsole: false,
		});
		await new Promise((r) => setTimeout(r, 50));
		app.unmount();
		expect(seen).toBe(CHAT_ROWS);
	});

	test("measured budget: latest reply visible, every fruit on its own line, chrome intact", async () => {
		const frame = await lastFrame(true);
		const chat = frame.slice(CHROME_TOP, CHROME_TOP + CHAT_ROWS);
		expect(frame[0]).toContain("HEADER-TOP");
		expect(frame[CHROME_TOP - 1]).toContain("HEADER-BOTTOM");
		expect(frame[ROWS - INPUT_ROWS]).toContain("INPUT-LINE");
		// The newest reply is on screen.
		expect(chat.join("\n")).toContain("Nectarine");
		expect(chat.join("\n")).toContain("Now the last one again.");
		// Every row is one thing: a header, a body line, or blank. Overprint
		// produced "Applent 04:21 PM" and "Nectarine4:21 PM" in the issue.
		expect(chat.some((l) => /^│ ◆ 8gent \d\d:\d\d [AP]M\s*$/.test(l))).toBe(true);
		expect(chat.some((l) => /^│ Nectarine\s*$/.test(l))).toBe(true);
		expect(chat.join("\n")).not.toMatch(/Applent|Nectarine\d/);
		// Everything in the window fits, so no clipped-top marker.
		expect(chat.join("\n")).not.toContain("earlier line");
	});

	test("even the old viewport guess no longer overprints", async () => {
		// 35 budgeted rows into a 13-row box is what produced "Applent" in the
		// issue: Ink squeezed shrinkable items and their lines collided. Items
		// are now unshrinkable and the list clips, so a wrong budget can cost
		// rows but can never stack text. Guards the second half of the fix.
		expect(Math.max(6, ROWS - 10)).toBeGreaterThan(CHAT_ROWS);
		const frame = await lastFrame(false);
		const chat = frame.slice(CHROME_TOP, CHROME_TOP + CHAT_ROWS);
		expect(chat.join("\n")).not.toMatch(/Applent|Nectarine\d/);
		// With the wrong budget the newest reply is still clipped off the
		// bottom; only the measured budget keeps it on screen (test above).
		expect(chat.join("\n")).not.toContain("Nectarine");
		expect(frame[CHROME_TOP - 1]).toContain("HEADER-BOTTOM");
		expect(frame[ROWS - INPUT_ROWS]).toContain("INPUT-LINE");
	});

	test("one message taller than the box: newest lines stay, no divider lands on a line", async () => {
		// The real /help output at 80x45 is ~40 lines in a 13-row box. Before,
		// the top showed, the tail was cut, and the closing divider overprinted
		// a command row ("───voice record").
		const help = Array.from(
			{ length: 30 },
			(_, i) => `  /cmd${String(i + 1).padStart(2, "0")} - does thing ${i + 1}`,
		);
		const tall: Message[] = [
			{
				id: "s1",
				role: "system",
				content: ["Available commands:", ...help].join("\n"),
				timestamp: at,
			},
		];
		const frame = await lastFrame(true, tall);
		const chat = frame.slice(CHROME_TOP, CHROME_TOP + CHAT_ROWS);
		expect(frame[CHROME_TOP - 1]).toContain("HEADER-BOTTOM");
		expect(frame[ROWS - INPUT_ROWS]).toContain("INPUT-LINE");
		expect(chat.join("\n")).toContain("/cmd30 - does thing 30");
		// The clipped top is announced on the first chat row. One message
		// only, so there is nothing to scroll to and no shift+↑ promise.
		expect(chat[0]).toMatch(/^↑ 22 earlier lines\s*$/);
		// 22 is exact: the top divider, the title and /cmd01 to /cmd20.
		expect(chat[1]).toContain("/cmd21 - does thing 21");
		expect(chat.join("\n")).not.toContain("/cmd01 ");
		for (const line of chat) expect(line).not.toMatch(/─+\S*\s*\/cmd|─{3}[a-z]/);
	});

	test("a reply taller than the box ends on its last line, not mid-way", async () => {
		// Pilot run 2026-09-29_170518: the finished summary showed its first
		// 25 lines and hid the rest, so the outcome was off screen.
		const body = Array.from({ length: 30 }, (_, i) => `step ${i + 1} done`).join("\n");
		const msgs: Message[] = [
			{ id: "u1", role: "user", content: "Summarise.", timestamp: at },
			{
				id: "a1",
				role: "assistant",
				content: `${body}\nAll requested steps are complete.`,
				timestamp: at,
			},
		];
		const chat = (await lastFrame(true, msgs)).slice(CHROME_TOP, CHROME_TOP + CHAT_ROWS).join("\n");
		expect(chat).toContain("All requested steps are complete.");
		expect(chat).toContain("step 30 done");
		// The user turn above is a whole message, so shift+↑ is offered.
		expect(chat.split("\n")[0]).toMatch(/^↑ \d+ earlier lines {2}shift\+↑\s*$/);
	});
});
