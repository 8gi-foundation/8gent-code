/** Onboarding choice step at 40 columns: every choice fits in a 24 row screen. */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import { OnboardingScreen } from "../OnboardingScreen.js";

class In extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read() {
		return null;
	}
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const choices = [1, 2, 3, 4, 5, 6].map((n) => ({
	label: `Choice ${n}`,
	value: String(n),
	description: `Description ${n}`,
}));

async function frame(cols: number) {
	let last = "";
	const out = new Writable({
		write(c, _e, cb) {
			const s = c.toString();
			if (s.length > 20) last = s;
			cb();
		},
	}) as Writable & { columns: number; rows: number; isTTY: boolean };
	out.columns = cols;
	out.rows = 24;
	out.isTTY = true;
	const inst = render(
		<OnboardingScreen
			steps={[{ question: "Name?", answer: "A", status: "done" }]}
			currentQuestion="How?"
			stepIndex={2}
			totalSteps={12}
			selectChoices={choices}
			onSelect={() => {}}
		/>,
		{
			stdin: new In() as unknown as NodeJS.ReadStream,
			stdout: out as unknown as NodeJS.WriteStream,
			stderr: out as unknown as NodeJS.WriteStream,
			debug: true,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await new Promise((r) => setTimeout(r, 300));
	inst.unmount();
	return strip(last);
}

test("40 columns: all six choices and the hint fit in 24 rows", async () => {
	const lines = (await frame(40)).split("\n");
	expect(lines.length).toBeLessThanOrEqual(24);
	expect(lines.join("\n")).toContain("6. Choice 6");
	expect(lines.join("\n")).toContain("Description 6");
});

test("100 columns: description stays on the label row", async () => {
	const f = await frame(100);
	expect(f).toContain("1. Choice 1  -  Description 1");
});
