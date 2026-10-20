/**
 * Drag to select (#4602): SGR press, drag and release over text Ink really
 * drew. The copied text and the OSC 52 bytes are asserted, and a plain click
 * on a tab still switches it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Box, type Instance, Text, render, useInput } from "ink";
import type React from "react";
import {
	clearSelection,
	clearTargets,
	handleMouse,
	onCopied,
	onSelectionChange,
	setSelectionIO,
} from "../../lib/click-targets.js";
import { copyText } from "../../lib/copy-answer.js";
import { _disposeMouse, installMouse, onMouse } from "../../lib/mouse-input.js";
import { wireSelection } from "../../lib/mouse-wiring.js";
import { osc52 } from "../../lib/text-selection.js";
import { TabBar } from "../TabBar.js";

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

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let instance: Instance | null = null;
let offs: Array<() => void> = [];

afterEach(() => {
	instance?.unmount();
	instance = null;
	for (const o of offs) o();
	offs = [];
	_disposeMouse();
	clearTargets();
	setSelectionIO(null, null);
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

async function mount(node: React.ReactElement, ownHandler = true) {
	const stdin = new FakeStdin();
	const out = new Writable({
		write(_c, _e, cb) {
			cb();
		},
	}) as Writable & { columns: number; rows: number };
	out.columns = 100;
	out.rows = 20;
	installMouse(
		stdin as unknown as NodeJS.ReadStream,
		{ write: () => true },
		{ enabled: true, processHooks: false },
	);
	if (ownHandler)
		offs.push(
			onMouse((e) => {
				if (e.kind !== "wheel" && e.kind !== "move") handleMouse(e);
			}),
		);
	instance = render(node, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: out as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick(80);
	// Ink keeps its last frame on the instance, as mouse-wiring reads it.
	const req = createRequire(import.meta.url);
	const dir = path.dirname(req.resolve("ink"));
	const m = await import(pathToFileURL(path.join(dir, "instances.js")).href);
	const frame = () =>
		((m.default as WeakMap<object, { lastOutput?: string }>).get(out)?.lastOutput ?? "").replace(
			ANSI,
			"",
		);
	return { stdin, frame };
}

const sgr = (kind: "press" | "drag" | "release", x: number, y: number) =>
	kind === "press"
		? `\x1b[<0;${x + 1};${y + 1}M`
		: kind === "drag"
			? `\x1b[<32;${x + 1};${y + 1}M`
			: `\x1b[<0;${x + 1};${y + 1}m`;

function Keys({ children }: { children: React.ReactNode }) {
	useInput(() => {});
	return <Box flexDirection="column">{children}</Box>;
}

function wire(frame: () => string) {
	const wrote: string[] = [];
	const heard: number[] = [];
	setSelectionIO(frame, (text) => {
		copyText(text, { write: (s) => wrote.push(s), env: {}, platform: "linux" });
	});
	offs.push(onCopied((n) => heard.push(n)));
	return { wrote, heard };
}

describe("drag select over rendered text", () => {
	test("press, drag, release copies the plain text as OSC 52 and says how many characters", async () => {
		const { stdin, frame } = await mount(
			<Keys>
				<Text color="red">alpha beta gamma</Text>
				<Text bold>delta epsilon</Text>
			</Keys>,
		);
		const { wrote, heard } = wire(frame);
		stdin.feed(sgr("press", 6, 0));
		stdin.feed(sgr("drag", 3, 1));
		stdin.feed(sgr("release", 3, 1));
		await tick();
		expect(wrote).toEqual([osc52("beta gamma\ndelt")]);
		expect(wrote[0]).not.toContain("\x1b[31m");
		expect(heard).toEqual([15]);
	});

	test("double click selects the word, triple click the line", async () => {
		const { stdin, frame } = await mount(
			<Keys>
				<Text>alpha beta gamma</Text>
			</Keys>,
		);
		const { wrote } = wire(frame);
		for (let i = 0; i < 2; i++) {
			stdin.feed(sgr("press", 7, 0));
			stdin.feed(sgr("release", 7, 0));
		}
		await tick();
		expect(wrote).toEqual([osc52("beta")]);
		stdin.feed(sgr("press", 7, 0));
		stdin.feed(sgr("release", 7, 0));
		await tick();
		expect(wrote[1]).toBe(osc52("alpha beta gamma"));
	});

	test("Escape's clearSelection drops the highlight and tells the painter", async () => {
		const { stdin, frame } = await mount(
			<Keys>
				<Text>alpha beta gamma</Text>
			</Keys>,
		);
		wire(frame);
		const ranges: Array<unknown> = [];
		offs.push(onSelectionChange((r) => ranges.push(r)));
		stdin.feed(sgr("press", 0, 0));
		stdin.feed(sgr("drag", 4, 0));
		stdin.feed(sgr("release", 4, 0));
		await tick();
		expect(ranges.at(-1)).toEqual({ x0: 0, y0: 0, x1: 4, y1: 0 });
		expect(clearSelection()).toBe(true);
		expect(ranges.at(-1)).toBeNull();
		expect(clearSelection()).toBe(false);
	});

	test("a click without a drag copies nothing and still switches tabs", async () => {
		const switched: string[] = [];
		const tabs = [
			{ id: "a", title: "Orchestrator", active: true, type: "chat" },
			{ id: "b", title: "Engineer", active: false, type: "chat" },
		] as unknown as Parameters<typeof TabBar>[0]["tabs"];
		const { stdin, frame } = await mount(
			<Keys>
				<TabBar tabs={tabs} onSwitch={(id) => switched.push(id)} animate={false} width={100} />
				<Text>some text under the tabs</Text>
			</Keys>,
		);
		const { wrote } = wire(frame);
		// A wobble of one cell on plain text is a click: nothing copied.
		stdin.feed(sgr("press", 5, 3));
		stdin.feed(sgr("drag", 6, 3));
		stdin.feed(sgr("release", 6, 3));
		await tick();
		expect(wrote).toEqual([]);
		// Find the Engineer tab by scanning the frame for its title.
		const row = frame()
			.split("\n")
			.findIndex((l) => l.includes("Engineer"));
		const col = frame().split("\n")[row].indexOf("Engineer");
		stdin.feed(sgr("press", col + 2, row));
		stdin.feed(sgr("release", col + 2, row));
		await tick();
		expect(switched).toEqual(["b"]);
		expect(wrote).toEqual([]);
	});
});

describe("the real wiring (wireSelection, as startMouse uses it)", () => {
	test("a drag over Ink's frame copies via OSC 52, paints reverse video, and Escape's clear repaints", async () => {
		const { stdin, frame } = await mount(
			<Keys>
				<Text color="red">alpha beta gamma</Text>
			</Keys>,
			false,
		);
		const screen: string[] = [];
		const heard: Array<[number, boolean]> = [];
		offs.push(onCopied((n, ok) => heard.push([n, ok])));
		const w = wireSelection({
			raw: frame,
			plain: frame,
			out: { write: (s) => screen.push(s) },
			copyDeps: { env: {}, platform: "linux" },
		});
		offs.push(w.off);
		stdin.feed(sgr("press", 6, 0));
		stdin.feed(sgr("drag", 9, 0));
		stdin.feed(sgr("release", 9, 0));
		await tick();
		expect(screen).toContain(osc52("beta"));
		expect(screen.some((s) => s.includes("\x1b[7mbeta\x1b[0m"))).toBe(true);
		expect(heard).toEqual([[4, true]]);
		const before = screen.length;
		clearSelection();
		expect(screen.slice(before).join("")).not.toContain("\x1b[7m");
	});

	test("over the OSC 52 cap with no local command, the notice says it was not copied", async () => {
		const long = "x".repeat(80);
		const { stdin, frame } = await mount(
			<Keys>
				<Text>{long}</Text>
			</Keys>,
			false,
		);
		const heard: Array<[number, boolean]> = [];
		offs.push(onCopied((n, ok) => heard.push([n, ok])));
		const w = wireSelection({
			raw: frame,
			plain: frame,
			out: { write: () => true },
			copyDeps: { env: { SSH_TTY: "x" }, platform: "linux", maxEncoded: 10 },
		});
		offs.push(w.off);
		stdin.feed(sgr("press", 0, 0));
		stdin.feed(sgr("drag", 40, 0));
		stdin.feed(sgr("release", 40, 0));
		await tick();
		expect(heard).toEqual([[41, false]]);
	});
});
