/**
 * MCP cards (`full`) are shown whole or refused by the TUI, from its real
 * geometry, and take no key before they have been on screen (#3474). The
 * shell is app.tsx's column structure with stand-in contents; every case
 * drives describeServer -> askMcp*Approval -> the approval channel ->
 * useApprovalCard -> InlineApprovalPrompt, rendered by Ink.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type DOMElement, type Instance, Text, render } from "ink";
import React, { useRef, useState } from "react";
import { describeServer } from "../../../../../packages/mcp/lean.js";
import {
	askMcpApproval,
	askMcpStartApproval,
} from "../../../../../packages/permissions/mcp-gate.js";
import { _resetTuiApprovalChannel } from "../../../../../packages/permissions/tui-approval-channel.js";
import {
	CARD_MIN_SHOW_MS,
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
	private queue: string[] = [];
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return this.queue.shift() ?? null;
	}
	/** One keypress, through Ink's own input path. */
	feed(chunk: string) {
		this.queue.push(chunk);
		this.emit("readable");
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
	const card = useApprovalCard();
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
		await tick(CARD_MIN_SHOW_MS);
		settleApprovalKey("n", {}, stdout);
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
	await tick(CARD_MIN_SHOW_MS + 20);
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
	await tick(CARD_MIN_SHOW_MS + 20);
	expect(strip(stdout.last)).toContain("mcp-fake/server.ts");
	settleApprovalKey("y", {}, stdout);
	expect(await answer).toBeNull();
});

const pending = (p: Promise<unknown>) => Promise.race([p, tick(5).then(() => "pending")]);

test("a key before the card has been on screen CARD_MIN_SHOW_MS is claimed, ignored, and restarts the wait", async () => {
	const stdout = await mount(120, 40, false);
	const answer = askMcpStartApproval(servers(3, (i) => `@scope/pkg-${i}`));
	await new Promise((r) => setImmediate(r)); // laid out, not yet painted
	expect(settleApprovalKey("y", {}, stdout)).toBe(false);
	await tick(CARD_MIN_SHOW_MS - 150);
	expect(settleApprovalKey("y", {}, stdout)).toBe(false);
	expect(await pending(answer)).toBe("pending");
	await tick(200); // 550 ms since the card came, 200 ms since the last key
	expect(settleApprovalKey("y", {}, stdout)).toBe(false);
	await tick(CARD_MIN_SHOW_MS + 20);
	expect(settleApprovalKey("y", {}, stdout)).toBe(true);
	expect(await answer).toBeNull();
});

/** Text typed for the chat, one key every 40 ms (25 chars/s), through Ink's stdin. */
async function typeAt25PerSecond(stdin: FakeStdin, text: string, onChar?: (i: number) => void) {
	for (let i = 0; i < text.length; i++) {
		onChar?.(i);
		stdin.feed(text[i] as string);
		await tick(40);
	}
}

async function mountWithStdin(cols: number, rows: number) {
	const stdin = new FakeStdin();
	const stdout = makeStdout(cols, rows);
	instance = render(<Shell plan={false} />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(cols, rows) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	return { stdin, stdout };
}

test("chat text typed as the card appears never answers it ('okay' holds a y)", async () => {
	const { stdin } = await mountWithStdin(120, 40);
	let answer: Promise<string | null> | null = null;
	// The card is raised while the person is mid-sentence; the y of "okay"
	// arrives ~720 ms after it, well past CARD_MIN_SHOW_MS on its own.
	await typeAt25PerSecond(stdin, "ok ok ok ok ok okay do it", (i) => {
		if (i === 0) answer = askMcpStartApproval(servers(3, (n) => `@scope/pkg-${n}`));
	});
	expect(answer).not.toBeNull();
	expect(await pending(answer as unknown as Promise<string | null>)).toBe("pending");
	// A deliberate Y after CARD_MIN_SHOW_MS of no keys approves.
	await tick(CARD_MIN_SHOW_MS + 20);
	stdin.feed("Y");
	expect(await answer).toBeNull();
});

test("the pilot's sequence (no key while the card is up, one key after 600 ms) still approves", async () => {
	const { stdin, stdout } = await mountWithStdin(120, 40);
	const answer = askMcpStartApproval(servers(1, () => "x"));
	await tick(120);
	expect(strip(stdout.last)).toContain("[Y] approve");
	await tick(600 - 120);
	stdin.feed("y");
	expect(await answer).toBeNull();
});

test("resized after the card was drawn: keys wait again; a shrink that clips it refuses it", async () => {
	const stdout = await mount(120, 40, false);
	const lines = servers(3, (i) => `@scope/pkg-${i}`);
	let answer = askMcpStartApproval(lines);
	await tick(CARD_MIN_SHOW_MS + 20);
	stdout.rows = 41; // no layout at this size yet
	expect(settleApprovalKey("y", {}, stdout)).toBe(false);
	stdout.rows = 40;
	await tick(CARD_MIN_SHOW_MS + 20); // that key restarted the wait
	settleApprovalKey("n", {}, stdout);
	expect(await answer).toStartWith("[PERMISSION DENIED]");
	answer = askMcpStartApproval(lines);
	await tick(120);
	expect(strip(stdout.last)).toContain("HIDDEN_LAST_SERVER_PAYLOAD");
	stdout.rows = 14;
	stdout.emit("resize");
	expect(await answer).toContain("does not fit on this screen");
	await tick(120);
	expect(strip(stdout.last)).not.toContain("approve");
});

/** A shell with no useViewport, a sibling above the card with its own state, and a hideable wrapper. */
let grow: (rows: number) => void = () => {};
let hide: (hidden: boolean) => void = () => {};
function Grower() {
	const [rows, setRows] = useState(1);
	grow = setRows;
	return (
		<Box height={rows} flexShrink={0}>
			<Text>GROWER</Text>
		</Box>
	);
}
function SiblingShell() {
	const p = useApprovalCard();
	const [hidden, setHidden] = useState(false);
	hide = setHidden;
	return (
		<FixedFrame>
			<Box flexGrow={1} flexDirection="column" minHeight={0}>
				<Grower />
				<Box flexGrow={1} minHeight={0} overflow="hidden">
					<Text>chat</Text>
				</Box>
				<Box display={hidden ? "none" : "flex"} flexDirection="column" flexShrink={0}>
					{p && <InlineApprovalPrompt target={p.target} full={p.full} />}
				</Box>
				<Box height={3} flexShrink={0} borderStyle="round">
					<Text>INPUT</Text>
				</Box>
			</Box>
		</FixedFrame>
	);
}
function mountSiblingShell(cols: number, rows: number): FakeStdout {
	const stdout = makeStdout(cols, rows);
	instance = render(<SiblingShell />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(cols, rows) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	return stdout;
}

test("a sibling above the card grows and pushes it off screen: the key is answered 'unfit', not approved", async () => {
	const stdout = mountSiblingShell(120, 40);
	await tick();
	const answer = askMcpStartApproval(servers(6, (i) => `pkg-${i}`));
	await tick(120);
	expect(strip(stdout.last)).toContain("HIDDEN_LAST_SERVER_PAYLOAD");
	// Only Grower re-renders: the card's own component does not commit again.
	grow(34);
	await tick(CARD_MIN_SHOW_MS + 20);
	expect(settleApprovalKey("y", {}, stdout)).toBe(false);
	expect(await answer).toContain("does not fit on this screen");
	await tick(120);
	expect(strip(stdout.last)).not.toContain("approve");
});

test("a card hidden by a display:none ancestor after it was shown is refused", async () => {
	const stdout = mountSiblingShell(120, 40);
	await tick();
	const answer = askMcpStartApproval(servers(2, (i) => `pkg-${i}`));
	await tick(120);
	expect(strip(stdout.last)).toContain("[Y] approve");
	hide(true);
	expect(await answer).toContain("does not fit on this screen");
});

test("a card under a display:none ancestor from its first commit is refused", async () => {
	mountSiblingShell(120, 40);
	await tick();
	hide(true);
	await tick();
	expect(await askMcpStartApproval(servers(2, (i) => `pkg-${i}`))).toContain(
		"does not fit on this screen",
	);
});

test("the hook re-checks on resize by itself, with no useViewport in the tree", async () => {
	const stdout = mountSiblingShell(120, 40);
	await tick();
	const answer = askMcpStartApproval(servers(3, (i) => `pkg-${i}`));
	await tick(120);
	expect(strip(stdout.last)).toContain("[Y] approve");
	stdout.rows = 6; // card plus input no longer fit
	stdout.emit("resize");
	expect(await answer).toContain("does not fit on this screen");
});

test("the card's own box is measured: clipped inside a shrunk wrapper, it is refused", async () => {
	const stdout = makeStdout(80, 14);
	function Wrapped() {
		const p = useApprovalCard();
		return (
			<FixedFrame>
				<Box flexGrow={1} flexDirection="column" minHeight={0}>
					<Box flexDirection="column">
						{p && <InlineApprovalPrompt target={p.target} full={p.full} />}
					</Box>
					<Box height={3} flexShrink={0} borderStyle="round">
						<Text>INPUT</Text>
					</Box>
				</Box>
			</FixedFrame>
		);
	}
	instance = render(<Wrapped />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	const answer = askMcpStartApproval(servers(13, (i) => `pkg-${i}`));
	expect(await answer).toContain("does not fit on this screen");
	await tick(120);
	expect(strip(stdout.last)).not.toContain("approve");
});

test("a full card taller than the screen is refused even with no frame around it", async () => {
	function Bare() {
		const p = useApprovalCard();
		return p ? <InlineApprovalPrompt target={p.target} full={p.full} /> : null;
	}
	instance = render(<Bare />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: makeStdout(120, 6) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	expect(await askMcpStartApproval(servers(6, (i) => `pkg-${i}`))).toContain(
		"does not fit on this screen",
	);
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
