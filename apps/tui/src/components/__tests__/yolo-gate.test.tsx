/**
 * The one yolo question (first card that would come up). Y saves yes, N saves
 * no, the real card then follows, and a second request never asks again.
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
	CARD_MIN_SHOW_MS,
	_resetApprovalCard,
	isApprovalKeyClaimed,
	useApprovalCard,
} from "../../hooks/useApprovalCard.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";
import { CommandInput } from "../command-input.js";

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

const answers: boolean[] = [];
let asked = false;

function Harness() {
	const pending = useApprovalCard(undefined, {
		needed: () => !asked,
		answer: (yes) => {
			asked = true;
			answers.push(yes);
		},
	});
	useInput((input, key) => {
		isApprovalKeyClaimed(input, key);
	});
	return (
		<Box flexDirection="column">
			{pending && (
				<InlineApprovalPrompt target={pending.target} reason={pending.reason} gate={pending.gate} />
			)}
		</Box>
	);
}

async function mount() {
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	instance = render(<Harness />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout() as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick(60);
	const frame = () => stripAnsi(stdout.last);
	const ask = () =>
		requestTuiApproval({
			action: "Execute Shell Command",
			details: "",
			command: "printf ok > a.txt",
		});
	return { stdin, frame, ask };
}

describe("yolo gate", () => {
	test.each([
		["y", true],
		["n", false],
	])("%s answers the question, then the real card follows, then never again", async (key, yes) => {
		answers.length = 0;
		asked = false;
		const { stdin, frame, ask } = await mount();
		const first = ask();
		await waitFor(() => frame().includes("Enable yolo mode?"), "gate shown");
		expect(frame()).toContain("[Y] yes");
		expect(frame()).not.toContain("[E] edit");
		stdin.feed(key); // typed as the card appears: ignored
		await tick(40);
		expect(answers).toEqual([]);
		await tick(CARD_MIN_SHOW_MS + 100);
		stdin.feed("e"); // not a gate key: nothing answers
		await tick(40);
		expect(answers).toEqual([]);
		stdin.feed(key);
		await waitFor(() => frame().includes("[Y] approve"), "real card after gate");
		expect(answers).toEqual([yes]);
		await tick(20);
		stdin.feed("y");
		expect(await first).toBe(true);
		// Second request: straight to the real card.
		const second = ask();
		await waitFor(() => frame().includes("[Y] approve"), "second card");
		expect(frame()).not.toContain("Enable yolo mode?");
		await tick(20);
		stdin.feed("n");
		expect(await second).toBe(false);
		expect(answers).toEqual([yes]);
	});
});
