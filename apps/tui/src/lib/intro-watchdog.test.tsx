/**
 * #4662: a splash whose mount and stdin readiness never resolve must not hold
 * startup. Real Ink into a fake terminal: the splash stand-in never calls
 * onDone and never reads a key, and the main screen still renders.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Instance, Text, render } from "ink";
import { useState } from "react";
import { INTRO_HARD_TIMEOUT_MS, armIntroWatchdog, useIntroWatchdog } from "./intro-watchdog.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return null;
	}
}

function fakeStdout() {
	const out = new EventEmitter() as EventEmitter & Record<string, unknown>;
	out.columns = 80;
	out.rows = 24;
	out.isTTY = true;
	out.frames = [] as string[];
	out.write = (s: string) => {
		(out.frames as string[]).push(s);
		return true;
	};
	return out;
}

let inst: Instance | undefined;
afterEach(() => {
	inst?.unmount();
	inst = undefined;
});

// The same wiring app.tsx uses, with a splash that never finishes.
function Shell({ ms, trace }: { ms: number; trace: (s: string, d?: string) => void }) {
	const [introVisible, setIntroVisible] = useState(true);
	useIntroWatchdog(introVisible, () => setIntroVisible(false), ms, trace);
	return introVisible ? <Text>splash stuck</Text> : <Text>main screen</Text>;
}

describe("intro watchdog", () => {
	test("a splash that never resolves still reaches the main screen, and the phases are logged", async () => {
		const phases: string[] = [];
		const stdout = fakeStdout();
		inst = render(<Shell ms={200} trace={(s) => phases.push(s)} />, {
			stdout: stdout as never,
			stdin: new FakeStdin() as never,
			debug: true,
			exitOnCtrlC: false,
		});
		await tick(50);
		expect(strip((stdout.frames as string[]).join(""))).toContain("splash stuck");
		await tick(400);
		const last = strip((stdout.frames as string[]).at(-1) ?? "");
		expect(last).toContain("main screen");
		expect(phases).toEqual(["intro-watchdog-armed", "intro-watchdog-fired"]);
	});

	test("the default ceiling is inside the 5 s launch budget", () => {
		expect(INTRO_HARD_TIMEOUT_MS).toBeLessThan(5000);
	});

	test("a splash that finishes first cancels the watchdog", async () => {
		const phases: string[] = [];
		let fired = false;
		const cancel = armIntroWatchdog(
			() => (fired = true),
			100,
			(s) => phases.push(s),
		);
		cancel();
		cancel();
		await tick(200);
		expect(fired).toBe(false);
		expect(phases).toEqual(["intro-watchdog-armed", "intro-watchdog-cleared"]);
	});
});
