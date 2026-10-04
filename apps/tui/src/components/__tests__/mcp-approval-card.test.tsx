/**
 * MCP cards (`full`) are shown whole or refused by the TUI, from its real
 * geometry (#3474, 8SO round 3). Round 2 guessed in packages/permissions
 * (stdout.columns - 4, 12 reserved rows, .length as width); the card really
 * sits in the chat column, 81 wide at 120 columns with the activity rail, 56
 * with the PLAN column open, under more chrome than guessed.
 *
 * The shell below is app.tsx's column structure (FixedFrame, header, tabs,
 * bordered shell, PLAN column, chat column with the focal strip, chat box,
 * card and input, activity rail, bottom bar), with stand-ins for the
 * components' contents. Every case drives the real path: describeServer ->
 * askMcpStartApproval / askMcpApproval -> the approval channel ->
 * useApprovalCard -> InlineApprovalPrompt, rendered by Ink. The rule checked:
 * every line of the card and its key row are on screen, or no card is on
 * screen and the request was refused.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type DOMElement, type Instance, Text, render } from "ink";
import React, { useRef } from "react";
import { describeServer } from "../../../../../packages/mcp/lean.js";
import {
	askMcpApproval,
	askMcpStartApproval,
} from "../../../../../packages/permissions/mcp-gate.js";
import { _resetTuiApprovalChannel } from "../../../../../packages/permissions/tui-approval-channel.js";
import {
	_resetApprovalCard,
	settleApprovalKey,
	useApprovalCard,
} from "../../hooks/useApprovalCard.js";
import { useViewport } from "../../hooks/useViewport.js";
import { ACTIVITY_RAIL_WIDTH, chatColumnWidth } from "../../lib/chat-layout.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";
import { FixedFrame } from "../fixed-frame/FixedFrame.js";

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read() {
		return null;
	}
}
type FakeStdout = Writable & { columns: number; rows: number; last: string };
function makeStdout(columns: number, rows: number): FakeStdout {
	const o = new Writable({
		write(chunk, _e, cb) {
			const s = chunk.toString();
			if (s.trim()) o.last = s;
			cb();
		},
	}) as FakeStdout;
	o.columns = columns;
	o.rows = rows;
	o.last = "";
	return o;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const PLAN_COLUMN_WIDTH = 24; // app.tsx
let instance: Instance | null = null;
let columnWidth = 0;
afterEach(() => {
	instance?.unmount();
	instance = null;
	_resetTuiApprovalChannel();
	_resetApprovalCard();
});

function Shell({ plan }: { plan: boolean }) {
	const column = useRef<DOMElement>(null);
	const card = useApprovalCard(undefined, column);
	const viewport = useViewport();
	columnWidth = column.current?.yogaNode?.getComputedWidth() ?? 0;
	return (
		<FixedFrame>
			<Box flexShrink={0}>
				<Text>HEADER</Text>
			</Box>
			<Box flexShrink={0}>
				<Text>TABS</Text>
			</Box>
			<Box borderStyle="single" paddingX={1} flexGrow={1} minHeight={0}>
				<Box flexGrow={1} minHeight={0} gap={1}>
					{plan && (
						<Box width={PLAN_COLUMN_WIDTH} flexShrink={0}>
							<Text>PLAN</Text>
						</Box>
					)}
					<Box ref={column} flexGrow={1} flexDirection="column" minWidth={0}>
						<Box height={3} flexShrink={0} borderStyle="round">
							<Text>NOW</Text>
						</Box>
						<Box flexGrow={1} minHeight={0} flexDirection="column" overflow="hidden">
							<Text>chat</Text>
						</Box>
						{card && (
							<InlineApprovalPrompt target={card.target} reason={card.reason} full={card.full} />
						)}
						<Box height={3} flexShrink={0} borderStyle="round">
							<Text>INPUT</Text>
						</Box>
					</Box>
					{viewport.width >= 90 && (
						<Box width={ACTIVITY_RAIL_WIDTH} flexShrink={0}>
							<Text>RAIL</Text>
						</Box>
					)}
				</Box>
			</Box>
			<Box flexShrink={0}>
				<Text>BOTTOMBAR</Text>
			</Box>
		</FixedFrame>
	);
}

async function mount(cols: number, rows: number, plan: boolean): Promise<FakeStdout> {
	const stdout = makeStdout(cols, rows);
	instance = render(<Shell plan={plan} />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(cols, rows) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	// The stand-in shell gives the chat column the width app.tsx sizes from.
	instance.rerender(<Shell plan={plan} />);
	await tick();
	expect(columnWidth).toBe(
		chatColumnWidth(cols, { planWidth: plan ? PLAN_COLUMN_WIDTH : 0, activity: cols >= 90 }),
	);
	return stdout;
}

/** Each of `musts` and the key row on screen, or no card and a refusal. */
async function wholeOrRefused(
	stdout: FakeStdout,
	answer: Promise<string | null>,
	musts: string[],
	count?: [string, number],
): Promise<"shown" | "refused"> {
	await tick(120);
	const screen = strip(stdout.last);
	const settled = await Promise.race([answer, tick(5).then(() => "pending" as const)]);
	if (settled === "pending") {
		for (const m of musts) expect(screen).toContain(m);
		if (count) expect(screen.split(count[0]).length - 1).toBe(count[1]);
		expect(screen).toContain("[Y] approve");
		expect(screen).toContain("INPUT");
		settleApprovalKey("n", {});
		expect(await answer).toStartWith("[PERMISSION DENIED]");
		return "shown";
	}
	expect(settled).toStartWith("[BLOCKED]");
	expect(settled).toContain("does not fit on this screen");
	expect(screen).not.toContain("approve");
	expect(screen).not.toContain("ASK");
	return "refused";
}

const servers = (n: number, arg: (i: number) => string) =>
	Array.from({ length: n }, (_, i) =>
		describeServer(
			i === n - 1
				? {
						type: "stdio",
						name: "evil",
						command: "/bin/sh",
						args: ["-c", "HIDDEN_LAST_SERVER_PAYLOAD"],
					}
				: { type: "stdio", name: `s${i}`, command: "npx", args: ["-y", arg(i)] },
		),
	);
const twelve = servers(12, (i) => `@scope/pkg-${i}-${"a".repeat(80)}`);
const lastServerMusts = ["HIDDEN_LAST_SERVER_PAYLOAD", "s0:", "s10:"];

for (const plan of [false, true]) {
	const layout = plan ? "PLAN column open" : "activity rail on";
	test(`120x30, ${layout}: the 12-server start card is whole on screen or refused`, async () => {
		const stdout = await mount(120, 30, plan);
		// 24+ rows of servers under this chrome in 29 rows: it cannot be whole.
		expect(await wholeOrRefused(stdout, askMcpStartApproval(twelve), lastServerMusts)).toBe(
			"refused",
		);
	});

	test(`120x30, ${layout}: a per-call card with an argument after 1.6 KB is whole or refused`, async () => {
		const stdout = await mount(120, 30, plan);
		const answer = askMcpApproval(
			"fs",
			"write_file",
			{
				path: "/tmp/notes.txt",
				content: "x ".repeat(800),
				then_also: "HIDDEN_LAST_SERVER_PAYLOAD",
			},
			undefined,
		);
		expect(
			await wholeOrRefused(stdout, answer, ["HIDDEN_LAST_SERVER_PAYLOAD", "fs/write_file"]),
		).toBe("refused");
	});

	test(`120x30, ${layout}: double-width arguments are measured as drawn`, async () => {
		const stdout = await mount(120, 30, plan);
		// 100 double-width characters are 200 columns: Ink wraps them as drawn.
		const answer = askMcpStartApproval(servers(3, () => "中".repeat(100)));
		expect(await wholeOrRefused(stdout, answer, ["HIDDEN_LAST_SERVER_PAYLOAD"], ["中", 200])).toBe(
			"shown",
		);
	});
}

test("a card that fits is shown whole and Y approves it", async () => {
	const stdout = await mount(120, 40, false);
	const answer = askMcpStartApproval(servers(3, (i) => `@scope/pkg-${i}`));
	expect(await wholeOrRefused(stdout, answer, ["HIDDEN_LAST_SERVER_PAYLOAD", "s0:", "s1:"])).toBe(
		"shown",
	);
	const again = askMcpStartApproval(servers(3, (i) => `@scope/pkg-${i}`));
	await tick(120);
	settleApprovalKey("y", {}, stdout);
	expect(await again).toBeNull();
});

test("the pilot's single-server card at 160x48 is shown, and Y starts it", async () => {
	const stdout = await mount(160, 48, true);
	const line = describeServer({
		type: "stdio",
		name: "ledger",
		command: "/Users/runner/.bun/bin/bun",
		args: ["/private/var/folders/xy/run-1790898045/mcp-fake/server.ts"],
	});
	const answer = askMcpStartApproval([line]);
	await tick(120);
	expect(strip(stdout.last)).toContain("mcp-fake/server.ts");
	settleApprovalKey("y", {}, stdout);
	expect(await answer).toBeNull();
});

test("resized after the card was drawn: Y is a no; a shrink that clips it refuses it", async () => {
	const stdout = await mount(120, 40, false);
	const lines = servers(3, (i) => `@scope/pkg-${i}`);
	// Size changed and no layout has run since: the card was not seen at this size.
	let answer = askMcpStartApproval(lines);
	await tick(120);
	stdout.rows = 41;
	settleApprovalKey("y", {}, stdout);
	expect(await answer).toStartWith("[PERMISSION DENIED]");
	stdout.rows = 40;
	// The terminal shrinks under a card: the re-render finds it clipped.
	answer = askMcpStartApproval(lines);
	await tick(120);
	expect(strip(stdout.last)).toContain("HIDDEN_LAST_SERVER_PAYLOAD");
	stdout.rows = 14;
	stdout.emit("resize");
	expect(await answer).toContain("does not fit on this screen");
	await tick(120);
	expect(strip(stdout.last)).not.toContain("approve");
});

test("a full card with no column to measure is refused, never drawn unchecked", async () => {
	function Bare() {
		const p = useApprovalCard();
		return p ? <InlineApprovalPrompt target={p.target} full={p.full} /> : null;
	}
	instance = render(<Bare />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: makeStdout(120, 40) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	expect(await askMcpStartApproval(["a: npx a"])).toContain("does not fit on this screen");
});

test("a card without `full` still renders on one truncated row (other tools unchanged)", async () => {
	const stdout = makeStdout(80, 30);
	instance = render(<InlineApprovalPrompt target={`cd /a/${"b".repeat(200)} && bun test`} />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(80, 30) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	expect(
		strip(stdout.last)
			.split("\n")
			.filter((l) => l.includes("│")).length,
	).toBe(1);
});
