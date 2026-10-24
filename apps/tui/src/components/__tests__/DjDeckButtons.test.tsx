/**
 * Tappable play/pause and stop on the DJ deck (#4907, James: "tappable controls
 * instead of typing a command"). The real DjDeck runs in Ink on a fake TTY with the
 * mouse layer on its stdin; the DJ talks to a fake mpv peer. A terminal-shaped click
 * lands on the rectangle the button registered, and the check is the player's state,
 * read from the peer, not the deck's own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render, useInput } from "ink";
import type React from "react";
import {
	DJ,
	setAudioGraceMs,
	setDjSpawn,
	setDjTools,
	setMpvTransport,
	setVolumeStore,
} from "../../../../../packages/music/dj";
import { clearTargets, handleMouse, hitTest } from "../../lib/click-targets.js";
import { _disposeMouse, installMouse, onMouse } from "../../lib/mouse-input.js";
import { DjDeck } from "../DjDeck";

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

let lastFrame = "";
function makeStdout(columns: number) {
	const out = new Writable({
		write(chunk, _enc, cb) {
			lastFrame = chunk.toString();
			cb();
		},
	}) as Writable & { columns: number; rows: number };
	out.columns = columns;
	out.rows = 20;
	return out;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
let instance: Instance | null = null;

async function mount(node: React.ReactElement, columns: number) {
	const stdin = new FakeStdin();
	installMouse(
		stdin as unknown as NodeJS.ReadStream,
		{ write: () => true },
		{ enabled: true, processHooks: false },
	);
	onMouse((e) => {
		if (e.kind !== "wheel" && e.kind !== "move") handleMouse(e);
	});
	instance = render(node, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: makeStdout(columns) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick(80);
	return stdin;
}

/** The app always has a useInput listening, which is what makes Ink read stdin at all. */
function Held({ children }: { children: React.ReactNode }) {
	useInput(() => {});
	return <>{children}</>;
}

/** Where a button was registered, found by hit-testing the screen as a click would. */
function find(id: string, columns: number): { x: number; y: number } | null {
	for (let y = 0; y < 4; y++)
		for (let x = 0; x < columns; x++) if (hitTest(x, y)?.id === id) return { x, y };
	return null;
}

function tap(stdin: FakeStdin, x: number, y: number) {
	stdin.feed(`\x1b[<0;${x + 1};${y + 1}M`);
	stdin.feed(`\x1b[<0;${x + 1};${y + 1}m`);
}

// ---- the fake mpv ----
let props: Record<string, unknown> = {};
function answer(line: string): string {
	const { command } = JSON.parse(line) as { command: [string, string, unknown?] };
	let reply: Record<string, unknown> = { error: "success" };
	if (command[0] === "get_property") {
		reply =
			command[1] in props && props[command[1]] !== null
				? { data: props[command[1]], error: "success" }
				: { error: "property unavailable" };
	} else if (command[0] === "set_property") props[command[1]] = command[2];
	else if (command[0] === "cycle" && command[1] === "pause") props.pause = !props.pause;
	return `${JSON.stringify(reply)}\n`;
}

let killed = 0;
function stubSpawn(): ChildProcess {
	const c = new EventEmitter() as EventEmitter & { kill(): boolean; unref(): void };
	c.kill = () => {
		killed++;
		return true;
	};
	c.unref = () => {};
	return c as unknown as ChildProcess;
}

beforeEach(async () => {
	killed = 0;
	props = {
		"mpv-version": "mpv 0.40.0",
		"idle-active": false,
		"current-ao": "opensles",
		"playback-time": 12,
		"time-pos": 12,
		duration: 200,
		volume: 100,
		mute: false,
		pause: false,
	};
	setMpvTransport(async (line) => answer(line));
	setDjSpawn(stubSpawn);
	setDjTools({ mpv: "/stub/mpv", ytdlp: "/stub/yt-dlp" });
	setVolumeStore({ load: () => null, save: () => {} });
	setAudioGraceMs(0);
	await new DJ().play("https://example.invalid/Lofi beats");
});
afterEach(() => {
	instance?.unmount();
	instance = null;
	_disposeMouse();
	clearTargets();
	new DJ().stop();
	setMpvTransport();
	setDjSpawn();
	setDjTools();
	setVolumeStore();
	setAudioGraceMs();
});

for (const columns of [120, 52]) {
	describe(`the deck at ${columns} columns`, () => {
		test("the label says pause while playing; a tap pauses mpv itself, and the label then says play", async () => {
			const stdin = await mount(
				<Held>
					<DjDeck columns={columns} />
				</Held>,
				columns,
			);
			await tick(1300); // the deck's one poll of the player
			expect(plain(lastFrame)).toContain("pause");
			expect(plain(lastFrame)).not.toContain("[Space] play");

			const b = find("djbtn:Space", columns);
			expect(b).not.toBeNull();
			tap(stdin, (b as { x: number }).x, (b as { y: number }).y);
			await tick(150);
			// The player, not the deck, is the witness.
			expect(props.pause).toBe(true);
			expect((await new DJ().status()).paused).toBe(true);
			await tick(1300);
			expect(plain(lastFrame)).toContain("[Space] play");
			expect(plain(lastFrame)).not.toContain("[Space] pause");

			// A second tap resumes it.
			const b2 = find("djbtn:Space", columns) as { x: number; y: number };
			tap(stdin, b2.x, b2.y);
			await tick(150);
			expect(props.pause).toBe(false);
			expect((await new DJ().status()).paused).toBe(false);
		}, 15000);

		test("a tap on stop ends the player and clears the deck", async () => {
			const stdin = await mount(
				<Held>
					<DjDeck columns={columns} />
				</Held>,
				columns,
			);
			await tick(1300);
			const b = find("djbtn:S", columns) as { x: number; y: number };
			expect(b).not.toBeNull();
			tap(stdin, b.x, b.y);
			await tick(150);
			expect(killed).toBe(1);
			expect((await new DJ().status()).playing).toBe(false);
			await tick(1300);
			expect(find("djbtn:S", columns)).toBeNull();
		}, 15000);

		test("a pause made outside the deck (the player paused itself) shows in the label", async () => {
			await mount(
				<Held>
					<DjDeck columns={columns} />
				</Held>,
				columns,
			);
			await tick(1300);
			props.pause = true; // mpv paused by something else
			await tick(1300);
			expect(plain(lastFrame)).toContain("[Space] play");
		}, 15000);
	});
}
