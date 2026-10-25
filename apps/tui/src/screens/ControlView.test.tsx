import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { render, renderToString } from "ink";
import React from "react";
import type { LoopRow } from "../lib/control-state.js";
import { controlStore } from "../lib/control-store.js";
import { ControlView, groupRows, headerLine } from "./ControlView.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");

function fakeTty() {
	const out = { text: "" };
	const stdout = new Writable({
		write(chunk, _e, cb) {
			out.text += chunk.toString();
			cb();
		},
	}) as Writable & { columns: number; rows: number };
	stdout.columns = 100;
	stdout.rows = 32;
	const stdin = Object.assign(new EventEmitter(), {
		isTTY: true,
		setRawMode() {},
		setEncoding() {},
		ref() {},
		unref() {},
		read: () => null,
	});
	return { out, stdout, stdin: stdin as unknown as NodeJS.ReadStream };
}

let home: string;
const realHome = process.env.HOME;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "control-view-"));
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = realHome;
	fs.rmSync(home, { recursive: true, force: true });
});

const row = (name: string, state: LoopRow["state"]): LoopRow => ({
	kind: "k",
	name,
	state,
	stage: "",
	last: null,
	next: null,
	waitingOn: null,
	detail: "",
});

describe("Control tab", () => {
	test("closed, it renders nothing and reads nothing; opened, it reads, shows rows and stops on unmount", async () => {
		const jobs = path.join(home, ".8gent", "jobs");
		fs.mkdirSync(jobs, { recursive: true });
		fs.writeFileSync(
			path.join(jobs, "a.json"),
			JSON.stringify({ name: "epics lane", state: "waiting-on-you", waitingOn: "your yes" }),
		);
		expect(renderToString(<ControlView visible={false} onClose={() => {}} />)).toBe("");
		expect(controlStore.subscribers()).toBe(0);
		expect(controlStore.get()).toBeNull();

		const { out, stdin, stdout } = fakeTty();
		const app = render(<ControlView visible={false} onClose={() => {}} />, {
			stdout: stdout as unknown as NodeJS.WriteStream,
			stdin,
			patchConsole: false,
		});
		await tick(50);
		expect(controlStore.subscribers()).toBe(0);
		expect(controlStore.get()).toBeNull();
		expect(strip(out.text)).not.toContain("CONTROL");

		app.rerender(<ControlView visible={true} onClose={() => {}} />);
		await tick(100);
		expect(controlStore.subscribers()).toBe(1);
		const frame = strip(out.text);
		expect(frame).toContain("CONTROL");
		expect(frame).toContain("WAITING ON YOU");
		expect(frame).toContain("epics lane");
		expect(frame).toContain("waiting on your yes");

		app.unmount();
		await tick(20);
		expect(controlStore.subscribers()).toBe(0);
		expect(controlStore.get()).toBeNull();
	});

	test("groups follow the order waiting, running, queued, stalled; done is counted, not listed", () => {
		const g = groupRows([
			row("s", "stalled"),
			row("q", "queued"),
			row("r", "running"),
			row("w", "waiting-on-you"),
			row("d", "done"),
		]);
		expect(g.groups.map((x) => x.state)).toEqual([
			"waiting-on-you",
			"running",
			"queued",
			"stalled",
		]);
		expect(g.flat.map((r) => r.name)).toEqual(["w", "r", "q", "s"]);
		expect(g.done).toBe(1);
	});

	test("header line shows load, free disk with floor and helper count with cap", () => {
		expect(
			headerLine({ load: 12.3, freeDiskGB: 31, diskFloorGB: 30, helpers: 3, helperCap: 4 }),
		).toBe("load 12.3  disk 31G floor 30  helpers 3/4");
		expect(
			headerLine({ load: 1, freeDiskGB: null, diskFloorGB: null, helpers: 0, helperCap: null }),
		).toBe("load 1  disk ?  helpers 0");
	});
});
