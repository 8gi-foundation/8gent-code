/**
 * Regression test for #2912: utility tabs (Settings, Notes, ...) must render
 * their view in the V2 centre column when they are the active tab.
 *
 * Renders the real App into fake streams (the same shape ink-testing-library
 * uses) under an isolated HOME so nothing touches the real ~/.8gent.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";
import React from "react";

setDefaultTimeout(30000);

const ESC = "\u001b";
const CTRL_N = "\u000e";
const SHIFT_TAB = "\u001b[Z";
const ENTER = "\r";
// Every chat tab boots with a welcome system message that starts with this
// prefix (the greeting after it is random). Utility views replace the message
// list, so its presence or absence tells us which view owns the centre column.
const CHAT_WELCOME = "\u221e 8gent Code";

class FakeStdout extends EventEmitter {
	columns = 120;
	rows = 40;
	isTTY = true;
	frames: string[] = [];
	write(chunk: string): boolean {
		this.frames.push(String(chunk));
		return true;
	}
	lastFrame(): string {
		return this.frames[this.frames.length - 1] ?? "";
	}
}

class FakeStdin extends EventEmitter {
	isTTY = true;
	private data: string | null = null;
	write(chunk: string): void {
		this.data = chunk;
		this.emit("readable");
		this.emit("data", chunk);
	}
	read(): string | null {
		const d = this.data;
		this.data = null;
		return d;
	}
	setEncoding(): void {}
	setRawMode(): void {}
	resume(): void {}
	pause(): void {}
	ref(): void {}
	unref(): void {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
	stdout: FakeStdout,
	predicate: (frame: string) => boolean,
	timeoutMs = 8000,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const frame = stdout.lastFrame();
		if (predicate(frame)) return frame;
		await sleep(50);
	}
	return stdout.lastFrame();
}

let tempHome: string;
let originalHome: string | undefined;
let unmount: (() => void) | null = null;
const stdout = new FakeStdout();
const stdin = new FakeStdin();

beforeAll(async () => {
	originalHome = process.env.HOME;
	tempHome = mkdtempSync(join(realOs.tmpdir(), "8gent-tui-2912-"));
	process.env.HOME = tempHome;
	// Bun's os.homedir() does not follow a runtime change to process.env.HOME,
	// and packages/settings resolves ~/.8gent from os.homedir() at module load.
	// Redirect it before the App (and everything it imports) is loaded so the
	// run cannot touch the real ~/.8gent.
	const patchedOs = { ...realOs, homedir: () => tempHome };
	mock.module("node:os", () => ({ ...patchedOs, default: patchedOs }));
	mock.module("os", () => ({ ...patchedOs, default: patchedOs }));
	mkdirSync(join(tempHome, ".8gent"), { recursive: true });
	writeFileSync(
		join(tempHome, ".8gent", "settings.json"),
		JSON.stringify({ performance: { introBanner: "off" } }),
	);

	const { render } = await import("ink");
	const { App } = await import("../app.js");
	// cliAutoApprove takes the --yes path, which skips onboarding in a fresh
	// HOME so the chat tab stays at its empty state and the frames below are
	// deterministic. No prompt is ever submitted, so nothing gets auto-approved.
	const instance = render(
		React.createElement(App, {
			initialCommand: "repl",
			args: [],
			sessionName: undefined,
			sessionResume: undefined,
			cliProvider: undefined,
			cliModel: undefined,
			cliAutoApprove: true,
		}),
		{
			stdout: stdout as unknown as NodeJS.WriteStream,
			stdin: stdin as unknown as NodeJS.ReadStream,
			debug: true,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	unmount = instance.unmount;
});

afterAll(() => {
	try {
		unmount?.();
	} catch {}
	if (originalHome !== undefined) process.env.HOME = originalHome;
	try {
		rmSync(tempHome, { recursive: true, force: true });
	} catch {}
});

describe("utility tabs render in the V2 centre column (#2912)", () => {
	test("/settings opens the Settings view", async () => {
		const ready = await waitFor(stdout, (f) => f.includes(CHAT_WELCOME), 20000);
		expect(ready).toContain(CHAT_WELCOME);
		stdin.write("/settings");
		await sleep(150);
		stdin.write(ENTER);
		// The centre column is narrow at 120 cols, so only assert on strings
		// short enough not to wrap (the settings.json path in the header does).
		const frame = await waitFor(stdout, (f) => f.includes("Categories"));
		expect(frame).toContain("Categories");
		expect(frame).toContain("Voice");
		expect(frame).toContain("Providers");
		expect(frame).not.toContain(CHAT_WELCOME);
	});

	test("Escape returns to the chat tab", async () => {
		stdin.write(ESC);
		const frame = await waitFor(stdout, (f) => f.includes(CHAT_WELCOME));
		expect(frame).not.toContain("Categories");
		expect(frame).toContain(CHAT_WELCOME);
	});

	test("Shift+Tab into Settings and q back keeps the conversation", async () => {
		// Regression: reaching a utility tab by cycling (Shift+Tab) and leaving
		// with q used to replace the chat with a fresh "New thread" welcome.
		stdin.write(ESC); // leave Notes, back to chat
		await waitFor(stdout, (f) => f.includes(CHAT_WELCOME));
		stdin.write(SHIFT_TAB);
		const settings = await waitFor(stdout, (f) => f.includes("Categories"));
		expect(settings).toContain("Categories");
		stdin.write("q");
		const back = await waitFor(stdout, (f) => !f.includes("Categories"));
		expect(back).toContain(CHAT_WELCOME);
		expect(back).not.toContain("New thread");
	});

	test("Ctrl+N opens the Notes view", async () => {
		stdin.write(CTRL_N);
		const frame = await waitFor(stdout, (f) => f.includes("Scratchpad:"));
		expect(frame).toContain("Scratchpad:");
		expect(frame).not.toContain(CHAT_WELCOME);
	});
});
