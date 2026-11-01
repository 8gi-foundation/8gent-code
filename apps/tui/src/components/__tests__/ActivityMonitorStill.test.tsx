/**
 * The activity monitor holds still while a turn runs (#4976, epic #4938).
 *
 * It used to run a 300 ms setInterval (800 ms with animations off) for the
 * whole turn: every tick redrew the full Ink screen to cycle "..." dots and a
 * scan bar and to re-read the activity log, whether or not anything happened.
 * lib/motion.ts says nothing loops. Now it redraws only when the activity log
 * or its props change.
 *
 * The frame count uses the same method as the idle-renders harness: Ink's
 * onRender, counted over a quiet window.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import { ActivityMonitor, clearActivity, completeActivity, pushActivity } from "../ActivityMonitor";

const src = readFileSync(join(import.meta.dir, "..", "ActivityMonitor.tsx"), "utf-8");
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type FakeStdout = Writable & { columns: number; rows: number; written: string };
function makeStdout(cols = 100, rows = 30): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.columns = cols;
	out.rows = rows;
	return out;
}

function mount(props: { compact: boolean; showAnimations: boolean }) {
	const stdout = makeStdout();
	let frames = 0;
	const app = render(
		<ActivityMonitor
			activeTool={null}
			stepCount={1}
			toolCount={0}
			processingStage="executing"
			showAnimations={props.showAnimations}
			compact={props.compact}
			contentWidth={80}
		/>,
		{
			stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout() as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
			onRender: () => {
				frames++;
			},
		},
	);
	return { app, stdout, frames: () => frames };
}

afterEach(() => clearActivity());

describe("ActivityMonitor holds still (#4976)", () => {
	test("no timer: no setInterval in the component", () => {
		expect(/setInterval\s*\(/.test(src)).toBe(false);
	});

	for (const compact of [true, false]) {
		test(`${compact ? "compact" : "full"} monitor, motion on: zero frames while nothing happens, one redraw per event`, async () => {
			// Full mode with no entries mounts the thinking visualiser, which
			// has its own motion; seed one entry so the window measures the
			// monitor alone.
			if (!compact) pushActivity("read_file", "seed", { path: "src/seed.ts" });
			const m = mount({ compact, showAnimations: true });
			try {
				await wait(150);
				const start = m.frames();
				await wait(1200);
				// The old 300 ms tick drew about four frames here.
				expect(m.frames() - start).toBe(0);

				const before = m.stdout.written.length;
				pushActivity("read_file", "call-1", { path: "src/app.tsx" });
				await wait(100);
				expect(m.frames() - start).toBeGreaterThanOrEqual(1);
				expect(strip(m.stdout.written.slice(before))).toContain("READ");

				const afterPush = m.frames();
				completeActivity("call-1", true, 42);
				await wait(100);
				expect(m.frames()).toBeGreaterThan(afterPush);

				const settled = m.frames();
				await wait(1000);
				expect(m.frames() - settled).toBe(0);
			} finally {
				m.app.unmount();
			}
		});
	}

	test("motion off is just as still", async () => {
		const m = mount({ compact: true, showAnimations: false });
		try {
			await wait(150);
			const start = m.frames();
			await wait(1000);
			expect(m.frames() - start).toBe(0);
		} finally {
			m.app.unmount();
		}
	});
});
