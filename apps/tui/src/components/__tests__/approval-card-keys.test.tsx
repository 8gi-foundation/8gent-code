/**
 * Inline approval card owns Y/N/E/S (#3055).
 *
 * Seen live: pressing Y at the card typed "y" into the chat input ("❯ y"),
 * and a Y that arrived right as the card was raised did not settle it at
 * all, so the card stayed up until a second Y ("❯ yy").
 *
 * These tests mount the real pieces the app wires together through Ink with
 * an in-memory stdin/stdout: useApprovalCard (handler registration + key
 * routing), InlineApprovalPrompt and the real CommandInput, plus an app-level
 * useInput guarded the same way app.tsx guards its keyboard handler. The
 * approval request goes through the real tui-approval-channel, the same path
 * PermissionManager and System One use.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type Instance, render, useInput } from "ink";
import React from "react";

import {
	_resetTuiApprovalChannel,
	requestTuiApproval,
} from "../../../../../packages/permissions/tui-approval-channel.js";
import {
	_resetApprovalCard,
	isApprovalKeyClaimed,
	useApprovalCard,
} from "../../hooks/useApprovalCard.js";
import { CommandInput } from "../command-input.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";

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
	feed(...chunks: string[]) {
		this.queue.push(...chunks);
		this.emit("readable");
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string; last: string };

function makeStdout(columns = 100): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			const s = chunk.toString();
			out.written += s;
			if (s.trim()) out.last = s;
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.last = "";
	out.columns = columns;
	out.rows = 30;
	return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(10);
	}
}

let instance: Instance | null = null;

afterEach(() => {
	instance?.unmount();
	instance = null;
	_resetTuiApprovalChannel();
	_resetApprovalCard();
});

/** The app's approval wiring, minus everything else app.tsx does. */
function Harness({
	onInputValue,
	appKeys,
}: {
	onInputValue: (v: string) => void;
	appKeys: string[];
}) {
	const approvalPending = useApprovalCard();
	// app.tsx's keyboard handler: a claimed card key stops here.
	useInput((input, key) => {
		if (isApprovalKeyClaimed(input, key)) return;
		if (input) appKeys.push(input);
	});
	return (
		<Box flexDirection="column">
			{approvalPending && <InlineApprovalPrompt target={approvalPending.target} />}
			<CommandInput
				onSubmit={() => {}}
				isProcessing={false}
				showAnimations={false}
				transformInputValue={(v) => {
					onInputValue(v);
					return v;
				}}
			/>
		</Box>
	);
}

async function mount() {
	const inputValues: string[] = [];
	const appKeys: string[] = [];
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	instance = render(<Harness onInputValue={(v) => inputValues.push(v)} appKeys={appKeys} />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout() as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await waitFor(() => stripAnsi(stdout.written).includes("Type a command"), "first frame");
	const frame = () => stripAnsi(stdout.last);
	const ask = (command: string) => requestTuiApproval({ action: "Execute Shell Command", details: "", command });
	return { stdin, frame, ask, inputValues, appKeys };
}

async function answerCard(keyPress: string) {
	const { stdin, frame, ask, inputValues, appKeys } = await mount();
	const decision = ask("printf ok > approved.txt");
	await waitFor(() => frame().includes("[Y] approve"), "card shown");
	await tick(20); // let the render's effects re-bind input handlers
	stdin.feed(keyPress);
	const result = await decision;
	await waitFor(() => !frame().includes("[Y] approve"), "card gone");
	await tick(30);
	return { result, frame: frame(), inputValues, appKeys };
}

describe("approval card key routing", () => {
	test("y approves, the input stays empty and the card goes away", async () => {
		const { result, frame, inputValues, appKeys } = await answerCard("y");
		expect(result).toBe(true);
		expect(inputValues).toEqual([]);
		expect(appKeys).toEqual([]);
		expect(frame).not.toContain("[Y] approve");
		expect(frame).toContain("Type a command");
	});

	test("Y (shift) approves too", async () => {
		const { result, inputValues } = await answerCard("Y");
		expect(result).toBe(true);
		expect(inputValues).toEqual([]);
	});

	test("n denies, the input stays empty and the card goes away", async () => {
		const { result, frame, inputValues, appKeys } = await answerCard("n");
		expect(result).toBe(false);
		expect(inputValues).toEqual([]);
		expect(appKeys).toEqual([]);
		expect(frame).not.toContain("[Y] approve");
	});

	test("e and s settle the card without typing into the input", async () => {
		for (const k of ["e", "s"]) {
			const { result, inputValues } = await answerCard(k);
			expect(result).toBe(false);
			expect(inputValues).toEqual([]);
			instance?.unmount();
			instance = null;
			_resetTuiApprovalChannel();
			_resetApprovalCard();
		}
	});

	test("y pressed the instant the card is raised still approves (no stale closure)", async () => {
		const { stdin, frame, ask, inputValues } = await mount();
		const decision = ask("printf ok > approved.txt");
		// No render has happened yet: this is the pilot/tmux race.
		stdin.feed("y");
		expect(await decision).toBe(true);
		await tick(60);
		expect(inputValues).toEqual([]);
		expect(frame()).not.toContain("[Y] approve");
	});

	test("a card key reaches the card once: a second y after it settles is typing again", async () => {
		const { stdin, frame, ask, inputValues } = await mount();
		const decision = ask("printf ok > approved.txt");
		await waitFor(() => frame().includes("[Y] approve"), "card shown");
		stdin.feed("y");
		expect(await decision).toBe(true);
		await waitFor(() => !frame().includes("[Y] approve"), "card gone");
		await tick(30);
		stdin.feed("y");
		await waitFor(() => inputValues.includes("y"), "second y typed");
		expect(inputValues).toEqual(["y"]);
	});

	test("other keys still type while a card is pending", async () => {
		const { stdin, frame, ask, inputValues } = await mount();
		const decision = ask("printf ok > approved.txt");
		await waitFor(() => frame().includes("[Y] approve"), "card shown");
		await tick(20);
		stdin.feed("h");
		await waitFor(() => inputValues.includes("h"), "h typed");
		expect(frame()).toContain("[Y] approve");
		stdin.feed("y");
		expect(await decision).toBe(true);
	});

	test("with no card pending, y goes to the chat input", async () => {
		const { stdin, frame, inputValues, appKeys } = await mount();
		stdin.feed("y");
		await waitFor(() => inputValues.includes("y"), "y typed");
		await tick(30);
		expect(inputValues).toEqual(["y"]);
		expect(appKeys).toEqual(["y"]);
		expect(frame()).toContain("y");
	});
});

describe("InlineApprovalPrompt label spacing", () => {
	test("a long target that truncates keeps a space after ASK", async () => {
		const stdout = makeStdout(80);
		const stdin = new FakeStdin();
		instance = render(
			<InlineApprovalPrompt target="cd /home/someone/.8gent/evidence/hud-design/calm/runs/after-160x48/work && bun test" />,
			{
				stdin: stdin as unknown as NodeJS.ReadStream,
				stdout: stdout as unknown as NodeJS.WriteStream,
				stderr: makeStdout() as unknown as NodeJS.WriteStream,
				debug: false,
				exitOnCtrlC: false,
				patchConsole: false,
			},
		);
		await waitFor(() => stripAnsi(stdout.written).includes("[S] skip"), "card frame");
		const f = stripAnsi(stdout.last);
		expect(f).toContain("ASK cd /home");
		expect(f).not.toContain("ASKcd");
	});
});

