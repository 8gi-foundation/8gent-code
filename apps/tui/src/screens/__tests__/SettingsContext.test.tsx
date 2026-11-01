/**
 * Settings, Context windows (#5035): one row per open chat tab, an override field,
 * reset to detected. HOME is faked so the settings file is never the real one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import React from "react";
import { removeDir } from "../../../../../tests/temp-dirs";
import type { ContextRow } from "../SettingsView.js";

let SettingsView: typeof import("../SettingsView.js").SettingsView;
let home: string;
let savedHome: string | undefined;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "settings5035-"));
	savedHome = process.env.HOME;
	process.env.HOME = home;
	({ SettingsView } = await import("../SettingsView.js"));
});
afterAll(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	removeDir(home);
});

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
	/** Deliver one or more chunks in a single readable event. */
	feed(...chunks: string[]) {
		this.queue.push(...chunks);
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
	out.rows = 30;
	return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

/** Poll until `check` passes, so tests key off renders, not wall-clock guesses. */
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
});

const ROWS: ContextRow[] = [
	{
		tabId: "tab-a",
		title: "Orchestrator",
		model: "m-flash",
		detected: 204800,
		override: null,
		active: true,
	},
	{
		tabId: "tab-b",
		title: "Engineer",
		model: "q-14b",
		detected: null,
		override: 64000,
		active: false,
	},
];

async function mount() {
	const calls: [string, number | null][] = [];
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	instance = render(
		<SettingsView
			visible={true}
			onClose={() => {}}
			contextRows={ROWS}
			onContextOverride={(id, n) => calls.push([id, n])}
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
	await waitFor(() => stripAnsi(stdout.written).includes("Categories"), "first frame");
	const press = async (data: string) => {
		stdin.feed(data);
		await tick(60);
	};
	// Down arrows walk fields, then spill into the next category, until the rows show.
	for (let i = 0; i < 80 && !stripAnsi(stdout.written).includes("(focused)"); i++) {
		await press("\u001B[B");
	}
	return { calls, press, all: () => stripAnsi(stdout.written) };
}

describe("Settings: Context windows", () => {
	test("one row per open tab, with the detected window and any override", async () => {
		const { all } = await mount();
		const out = all();
		expect(out).toContain("Orchestrator (focused)");
		expect(out).toContain("detected 205k");
		expect(out).toContain("Engineer");
		expect(out).toContain("detected unknown, override 64k");
	});

	test("typing a size sets that tab's override; empty input or r resets to detected", async () => {
		const { calls, press } = await mount();
		await press("e");
		await press("1");
		await press("2");
		await press("8");
		await press("k");
		await press("\r");
		expect(calls).toEqual([["tab-a", 128000]]);
		await press("e");
		await press("\r");
		expect(calls[1]).toEqual(["tab-a", null]);
		await press("r");
		expect(calls[2]).toEqual(["tab-a", null]);
	});

	test("something that is not a size changes nothing", async () => {
		const { calls, press } = await mount();
		await press("e");
		await press("x");
		await press("\r");
		expect(calls).toEqual([]);
	});
});
