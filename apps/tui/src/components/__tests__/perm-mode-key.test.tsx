/**
 * Permission modes in the TUI (#3170): Shift+Tab, the footer, the rail.
 *
 * The key tests mount the REAL CommandInput through Ink with an in-memory
 * TTY and write the exact bytes a terminal sends for Shift+Tab (ESC [ Z),
 * next to a handler that uses the same predicate and cycle the app uses
 * (isPermissionCycleKey, nextPermissionMode). Ink hands one keypress to every
 * active handler, so this proves both halves at once: the mode moves, and the
 * chat input neither types the key nor takes it as "accept the suggestion".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, Text, render, useInput } from "ink";
import React, { useState } from "react";
import {
	PERMISSION_MODES,
	type PermissionMode,
	nextPermissionMode,
} from "../../../../../packages/permissions/permission-mode.js";
import {
	PERM_KEY,
	PERM_LOOK,
	isPermissionCycleKey,
	permColour,
	permSwitchLine,
} from "../../lib/perm-modes-design.js";
import { theme } from "../../theme.js";
import {
	FOOTER_HINTS,
	buildFooterSegments,
	fitFooterHints,
	fitFooterSegments,
} from "../StatusFooter.js";
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

type FakeStdout = Writable & { columns: number; rows: number; written: string };
function makeStdout(columns = 100): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
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

const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";

/** The app's Shift+Tab handler, reduced to its decision: same predicate, same cycle. */
function PermProbe({ onMode }: { onMode: (m: PermissionMode) => void }) {
	const [mode, setMode] = useState<PermissionMode>("ask");
	useInput((_input, key) => {
		if (isPermissionCycleKey(key)) {
			const next = nextPermissionMode(mode);
			setMode(next);
			onMode(next);
		}
	});
	return <Text>PERM:{mode}</Text>;
}

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

async function mount() {
	const submitted: string[] = [];
	const modes: PermissionMode[] = [];
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	instance = render(
		<>
			<PermProbe onMode={(m) => modes.push(m)} />
			<CommandInput
				onSubmit={(v) => submitted.push(v)}
				isProcessing={false}
				showAnimations={false}
			/>
		</>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout() as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await waitFor(() => stripAnsi(stdout.written).includes("PERM:ask"), "first frame");
	const press = async (data: string, expect?: string) => {
		const mark = stdout.written.length;
		stdin.feed(data);
		if (expect !== undefined) {
			await waitFor(() => stripAnsi(stdout.written.slice(mark)).includes(expect), expect);
			await tick(20);
		} else {
			await tick(60);
		}
	};
	const submit = async () => {
		stdin.feed("\r");
		await waitFor(() => submitted.length > 0, "submit").catch(() => {});
	};
	return { submitted, modes, press, submit };
}

describe("Shift+Tab through real Ink", () => {
	test("cycles ask -> guarded -> infinite -> plan -> ask and types nothing into the input", async () => {
		const { submitted, modes, press, submit } = await mount();
		await press("hi", "hi");
		await press(SHIFT_TAB, "PERM:guarded");
		await press(SHIFT_TAB, "PERM:infinite");
		await press(SHIFT_TAB, "PERM:plan");
		await press(SHIFT_TAB, "PERM:ask");
		await submit();
		expect(modes).toEqual(["guarded", "infinite", "plan", "ask"]);
		expect(submitted).toEqual(["hi"]);
	});

	test("with a ghost suggestion showing, Shift+Tab does not accept it; Tab still does and does not cycle", async () => {
		const first = await mount();
		await first.press("bun", "run dev"); // the ghost suggestion is on screen
		await first.press(SHIFT_TAB, "PERM:guarded");
		await first.submit();
		expect(first.submitted).toEqual(["bun"]);
		instance?.unmount();

		const second = await mount();
		await second.press("bun", "run dev");
		await second.press(TAB);
		await second.submit();
		expect(second.submitted).toEqual(["bun run dev"]);
		expect(second.modes).toEqual([]);
	});
});

describe("the footer shows the true mode", () => {
	test("Plan, Guarded and Infinite are a never-dropping perm segment in their colour; Ask is quiet", () => {
		for (const m of PERMISSION_MODES) {
			const segs = buildFooterSegments({
				mode: "Planning",
				permissions: m,
			});
			const perm = segs.find((s) => s.key === "perm");
			expect(segs.some((s) => s.key === "approval")).toBe(false);
			if (m === "ask") {
				expect(perm).toBeUndefined();
				continue;
			}
			expect(perm?.value).toBe(PERM_LOOK[m].name);
			expect(perm?.hint).toBe(PERM_KEY);
			expect(perm?.priority).toBe(0);
			expect(perm?.color).toBe(permColour(m));
			expect(perm?.bold).toBe(m === "infinite");
			// Squeezed to nothing, mode and perm both stay.
			expect(fitFooterSegments(segs, 10).map((s) => s.key)).toEqual(["mode", "perm"]);
		}
		expect(permColour("plan")).toBe(theme.color.steel);
		expect(permColour("guarded")).toBe(theme.color.green);
		expect(permColour("infinite")).toBe(theme.color.orange);
	});

	test("the key is taught in the hints only while the segment is not showing it", () => {
		expect(FOOTER_HINTS).toContain(`${PERM_KEY} perm`);
		expect(fitFooterHints(999, false)).toContain(`${PERM_KEY} perm`);
		expect(fitFooterHints(999, true)).not.toContain(`${PERM_KEY} perm`);
	});

	test("a switch is one plain chat line naming the mode, for a screen reader", () => {
		expect(permSwitchLine("guarded")).toBe(
			`Permissions: Guarded: safe steps run, risky ones still ask (${PERM_KEY} to change)`,
		);
		expect(permSwitchLine("infinite")).toContain("never asks");
	});
});
