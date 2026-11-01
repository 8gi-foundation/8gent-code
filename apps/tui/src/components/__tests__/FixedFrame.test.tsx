/**
 * #3227: a HUD exactly as tall as the terminal makes Ink take its
 * fullscreen branch, which writes clearTerminal (erase screen AND scrollback)
 * before every commit. Rishi measured 25 of them a minute on an idle HUD.
 * The frame is one row short, so a commit updates in place.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Text, render } from "ink";
import React, { useEffect, useState } from "react";
import { frameHeight } from "../fixed-frame/FixedFrame.js";
import { FixedFrame } from "../fixed-frame/index.js";

class TtyOut extends EventEmitter {
	isTTY = true;
	columns = 60;
	rows = 12;
	written = "";
	write = (s: string) => {
		this.written += s;
		return true;
	};
}

const CLEAR_TERMINAL = "\u001B[2J";
const CLEAR_SCROLLBACK = "\u001B[3J";

function Ticking({ commits }: { commits: number }) {
	const [n, setN] = useState(0);
	useEffect(() => {
		if (n >= commits) return;
		const id = setTimeout(() => setN((v) => v + 1), 5);
		return () => clearTimeout(id);
	}, [n, commits]);
	return (
		<FixedFrame>
			<Text>tick {n}</Text>
		</FixedFrame>
	);
}

describe("FixedFrame (#3227)", () => {
	test("the frame is one row shorter than the terminal", () => {
		expect(frameHeight(48)).toBe(47);
		expect(frameHeight(24)).toBe(23);
		expect(frameHeight(1)).toBe(1);
	});

	test("ten commits on a TTY never clear the screen or the scrollback", async () => {
		const out = new TtyOut();
		const app = render(<Ticking commits={10} />, {
			stdout: out as unknown as NodeJS.WriteStream,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		const start = Date.now();
		while (!out.written.includes("tick 10") && Date.now() - start < 3000) {
			await new Promise((r) => setTimeout(r, 10));
		}
		app.unmount();
		expect(out.written).toContain("tick 10");
		expect(out.written.includes(CLEAR_TERMINAL)).toBe(false);
		expect(out.written.includes(CLEAR_SCROLLBACK)).toBe(false);
	});
});
