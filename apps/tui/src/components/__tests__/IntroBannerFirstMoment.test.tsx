/**
 * The first moment is never blank and never waits forever (#4540).
 * Kept apart from IntroBanner.test.tsx so it adds nothing to that file.
 */
import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Instance, render } from "ink";
import { INTRO_AUTO_ADVANCE_MS, INTRO_STARTING_LINE, IntroBanner } from "../IntroBanner.js";

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

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

function mount(speed: number, autoAdvanceMs?: number) {
	const frames: string[] = [];
	const out = new EventEmitter() as EventEmitter & Record<string, unknown>;
	out.columns = 100;
	out.rows = 32;
	out.isTTY = false;
	out.write = (s: string) => {
		frames.push(strip(s));
		return true;
	};
	const calls: (string | undefined)[] = [];
	instance = render(
		<IntroBanner
			sound={false}
			rich
			colour={false}
			speed={speed}
			autoAdvanceMs={autoAdvanceMs}
			onDone={(c) => calls.push(c)}
		/>,
		{
			stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
			stdout: out as unknown as NodeJS.WriteStream,
			debug: true,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	return { frames, calls };
}

test("a visible status line shows in the first frames, within 200 ms", async () => {
	const { frames } = mount(1);
	await tick(150);
	expect(frames.some((f) => f.includes(INTRO_STARTING_LINE))).toBe(true);
});

test("with a stalled animation clock and no key, the splash still advances at the deadline", async () => {
	// speed 0.001 freezes the animation in its first beat, as a stalled loop would.
	const { calls } = mount(0.001, 300);
	await tick(150);
	expect(calls).toEqual([]);
	await tick(300);
	expect(calls).toEqual([undefined]);
});

test("the default deadline is 4 s", () => {
	expect(INTRO_AUTO_ADVANCE_MS).toBe(4000);
});
