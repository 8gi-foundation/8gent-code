import { afterEach, describe, expect, test } from "bun:test";
import {
	isOutputExpanded,
	outCommand,
	resetToolOutputForTests,
	subscribeToolOutput,
	toggleLatestOutput,
	toggleOutput,
	toolOutputVersion,
} from "./tool-output-state";
import { type ToolTrailEntry, toTrailEntry } from "./tool-trail";

afterEach(() => resetToolOutputForTests());

const entry = (resultFull?: string): ToolTrailEntry =>
	toTrailEntry({
		toolName: "run_command",
		args: { command: "bun test" },
		success: true,
		resultPreview: resultFull?.slice(0, 20),
		resultFull,
	});
const msg = (e: ToolTrailEntry) => ({ toolTrail: e });

describe("expanded state", () => {
	test("toggle flips one call and bumps the version, and listeners hear it", () => {
		let heard = 0;
		const off = subscribeToolOutput(() => heard++);
		const v0 = toolOutputVersion();
		expect(isOutputExpanded(5)).toBe(false);
		expect(toggleOutput(5)).toBe(true);
		expect(isOutputExpanded(5)).toBe(true);
		expect(isOutputExpanded(6)).toBe(false);
		expect(toggleOutput(5)).toBe(false);
		expect(isOutputExpanded(5)).toBe(false);
		expect(toolOutputVersion()).toBe(v0 + 2);
		expect(heard).toBe(2);
		off();
		toggleOutput(1);
		expect(heard).toBe(2);
	});
});

describe("Ctrl+O", () => {
	test("toggles the newest call that has output", () => {
		const a = entry("one");
		const b = entry("two");
		const c = entry();
		const msgs = [msg(a), msg(b), msg(c)];
		expect(toggleLatestOutput(msgs)).toBe(true);
		expect(isOutputExpanded(b.seq as number)).toBe(true);
		expect(isOutputExpanded(a.seq as number)).toBe(false);
		expect(toggleLatestOutput(msgs)).toBe(true);
		expect(isOutputExpanded(b.seq as number)).toBe(false);
	});
	test("with no output anywhere it does nothing and says so by returning false", () => {
		expect(toggleLatestOutput([msg(entry())])).toBe(false);
		expect(toggleLatestOutput([])).toBe(false);
	});
});

describe("/out", () => {
	test("no argument toggles the latest and names it", () => {
		const a = entry("Exit code 1:\nboom");
		const text = outCommand("", [msg(a)]);
		expect(isOutputExpanded(a.seq as number)).toBe(true);
		expect(text).toContain(`#${a.seq}`);
		expect(text).toContain("open");
		expect(outCommand("", [msg(a)])).toContain("closed");
		expect(isOutputExpanded(a.seq as number)).toBe(false);
	});
	test("a number picks that call, with or without a # or /out prefix style", () => {
		const a = entry("alpha");
		const b = entry("beta");
		const msgs = [msg(a), msg(b)];
		outCommand(String(a.seq), msgs);
		expect(isOutputExpanded(a.seq as number)).toBe(true);
		expect(isOutputExpanded(b.seq as number)).toBe(false);
		outCommand(`#${b.seq}`, msgs);
		expect(isOutputExpanded(b.seq as number)).toBe(true);
	});
	test("unknown number, junk, and no output give a plain line and change nothing", () => {
		const a = entry("alpha");
		expect(outCommand("999999", [msg(a)])).toContain("No tool output #999999");
		expect(outCommand("banana", [msg(a)])).toContain("Usage: /out");
		expect(outCommand("", [])).toContain("No tool output yet");
		expect(outCommand("1 2", [msg(a)])).toContain("Usage: /out");
		expect(isOutputExpanded(a.seq as number)).toBe(false);
	});
	test("a call whose output was not kept is said, not toggled", () => {
		const noOut = entry();
		expect(outCommand(String(noOut.seq), [msg(noOut)])).toContain("kept no output");
		expect(isOutputExpanded(noOut.seq as number)).toBe(false);
	});
});
