/**
 * The deck's key caps drive the real DJ, only while the deck has the
 * keyboard (#3188). The DJ runs for real here; only its processes are stubs,
 * through the spawn seam, so no mpv starts and nothing outside this test is
 * ever signalled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, Text, render } from "ink";
import React from "react";
import { DJ, setDjSpawn, setDjTools, setVolumeStore } from "../../../../../packages/music/dj";
import { DjDeck } from "../DjDeck";
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
	feed(chunk: string) {
		this.queue.push(chunk);
		this.emit("readable");
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string };
function makeStdout(): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.columns = 100;
	out.rows = 20;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, label: string, timeoutMs = 4000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(20);
	}
}

interface Child extends EventEmitter {
	cmd: string;
	signals: (string | number | undefined)[];
}
const children: Child[] = [];

let instance: Instance | null = null;

beforeEach(() => {
	children.length = 0;
	setDjTools({ mpv: "/stub/mpv", ytdlp: "/stub/yt-dlp" });
	setVolumeStore({ load: () => 60, save: () => {} });
	setDjSpawn(((cmd: string) => {
		const c = new EventEmitter() as Child & { kill: (s?: string) => boolean; unref: () => void };
		c.cmd = cmd;
		c.signals = [];
		c.kill = (s) => {
			c.signals.push(s);
			return true;
		};
		c.unref = () => {};
		children.push(c);
		return c;
	}) as never);
});

afterEach(() => {
	instance?.unmount();
	instance = null;
	new DJ().stop();
	setDjSpawn();
	setDjTools();
	setVolumeStore();
});

async function mountPlaying(keysActive: boolean) {
	await new DJ().play("https://example.invalid/no-agreement");
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	let done = 0;
	instance = render(
		<DjDeck
			footer={<Text>footer</Text>}
			columns={100}
			keysActive={keysActive}
			onKeysDone={() => done++}
		/>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout() as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	const frame = () => stripAnsi(stdout.written);
	await waitFor(() => frame().includes("DJ ▶"), "the DJ row");
	return { stdin, stdout, frame, done: () => done };
}

describe("DJ keys (#3188)", () => {
	test("with the keyboard: the caps show, Space pauses, S stops by the DJ's own handle and hands the keyboard back", async () => {
		const { stdin, stdout, frame, done } = await mountPlaying(true);
		await waitFor(() => frame().includes("[Space ▶❚]"), "the key caps");
		await tick(100); // let the post-commit effect bind the deck's input handler
		const mpv = children.find((c) => c.cmd === "/stub/mpv");
		expect(mpv?.signals).toEqual([]);

		let mark = stdout.written.length;
		stdin.feed(" ");
		await waitFor(() => stripAnsi(stdout.written.slice(mark)).includes("DJ ❚❚"), "paused", 8000);

		mark = stdout.written.length;
		stdin.feed("s");
		await waitFor(() => (mpv?.signals.length ?? 0) > 0, "stop");
		expect(mpv?.signals).toEqual(["SIGTERM"]);
		// Stopped: the DJ row goes and nothing takes its place (#3238: no
		// "8GENT FM idle"); the last frame is the footer alone.
		const lastFrame = () => {
			const s = stdout.written.slice(mark);
			return stripAnsi(s.slice(s.lastIndexOf("\u001B[G") + 1));
		};
		await waitFor(
			() => lastFrame().includes("footer") && !lastFrame().includes("DJ"),
			"the DJ row gone",
		);
		expect(done()).toBeGreaterThan(0);
	}, 20000);

	test("without the keyboard: one row, the ^D cap, and plain keys never touch the player", async () => {
		const { stdin, frame } = await mountPlaying(false);
		expect(frame()).toContain("[^D] keys");
		expect(frame()).not.toContain("[Space ▶❚]");
		stdin.feed("s");
		stdin.feed(" ");
		await tick(150);
		expect(children.find((c) => c.cmd === "/stub/mpv")?.signals).toEqual([]);
	}, 20000);
});

describe("the chat input while the deck has the keyboard", () => {
	async function typeInto(typingPaused: boolean): Promise<string> {
		const stdin = new FakeStdin();
		const stdout = makeStdout();
		const submitted: string[] = [];
		instance = render(
			<CommandInput
				onSubmit={(v) => submitted.push(v)}
				isProcessing={false}
				showAnimations={false}
				typingPaused={typingPaused}
			/>,
			{
				stdin: stdin as unknown as NodeJS.ReadStream,
				stdout: stdout as unknown as NodeJS.WriteStream,
				stderr: makeStdout() as unknown as NodeJS.WriteStream,
				debug: false,
				exitOnCtrlC: false,
				patchConsole: false,
			},
		);
		await waitFor(() => stripAnsi(stdout.written).includes("Type a command"), "first frame");
		await tick(50);
		for (const k of ["-", "-", " ", "n", "s"]) {
			stdin.feed(k);
			await tick(20);
		}
		await tick(100);
		instance.unmount();
		instance = null;
		const frames = stripAnsi(stdout.written).split("❯");
		return frames[frames.length - 1] ?? "";
	}

	test('deck keys never type into the chat (the live run showed "--" in the input)', async () => {
		expect(await typeInto(true)).not.toMatch(/--|ns/);
		// Control: the same keys do type when the chat has the keyboard.
		expect(await typeInto(false)).toContain("-- ns");
	}, 20000);
});
