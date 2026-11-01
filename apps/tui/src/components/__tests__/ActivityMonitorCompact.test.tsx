/** Compact activity monitor keeps its label, ellipsis and step count readable (#4938). */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import { ActivityMonitor, clearActivity, completeActivity, pushActivity } from "../ActivityMonitor";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
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

async function frame(cols: number): Promise<string[]> {
	let written = "";
	const out = new Writable({
		write(c, _e, cb) {
			written += c.toString();
			cb();
		},
	}) as Writable & { columns: number; rows: number };
	out.columns = cols;
	out.rows = 30;
	pushActivity("read_file", "a1", { path: "apps/tui/src/components/ActivityMonitor.tsx" });
	completeActivity("a1", true, 420);
	pushActivity("run_command", "a2", {
		command: "bun test apps/tui/src/components/__tests__/ActivityRail.test.tsx --bail",
	});
	const app = render(
		<ActivityMonitor
			activeTool="run_command"
			stepCount={12}
			toolCount={7}
			processingStage="executing"
			showAnimations={false}
			compact
			contentWidth={cols - 2}
		/>,
		{
			stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
			stdout: out as unknown as NodeJS.WriteStream,
			stderr: out as unknown as NodeJS.WriteStream,
			debug: true,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await new Promise((r) => setTimeout(r, 250));
	app.unmount();
	return strip(written)
		.split("\n")
		.filter((l) => l.trim())
		.slice(-4);
}

afterEach(() => clearActivity());

describe("ActivityMonitor compact", () => {
	test("100 columns: command is not cut at 50 and the step count sits right", async () => {
		const rows = await frame(100);
		expect(rows[2]).toContain("ActivityRail.test.tsx --bail");
		expect(rows[2]).toContain("step 12");
	});
	test("40 columns: label whole, ellipsis marks the cut, step count on one row", async () => {
		const rows = await frame(40);
		expect(rows[1]).toContain("READ");
		expect(rows[2]).toContain("… #12");
		expect(rows.join("\n")).not.toContain("co12");
	});
});
