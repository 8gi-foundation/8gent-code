import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BOOT_TRACE_MAX_BYTES, bootTrace, readBootTraceTail } from "./boot-trace.js";

let dir: string;
let file: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-trace-"));
	file = path.join(dir, "nested", "logs", "tui-boot.log");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("boot-trace", () => {
	test("appends one line per stage, creating the directory", () => {
		expect(bootTrace("a", "x=1", { file })).toBe(true);
		expect(bootTrace("b", undefined, { file })).toBe(true);
		const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/\+\d+(\.\d)?ms pid=\d+ a x=1$/);
		expect(lines[1]).toMatch(/ b$/);
	});
	test("caps the file by keeping the last half, on a line boundary", () => {
		const big = "z".repeat(1000);
		for (let i = 0; i < 300; i++) bootTrace(`s${i}`, big, { file });
		const size = fs.statSync(file).size;
		expect(size).toBeLessThanOrEqual(BOOT_TRACE_MAX_BYTES);
		const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
		expect(lines.at(-1)).toContain("s299");
		for (const l of lines) expect(l).toMatch(/^\d{4}-/);
	});
	test("EIGHT_BOOT_TRACE=0 writes nothing", () => {
		expect(bootTrace("a", undefined, { file, env: { EIGHT_BOOT_TRACE: "0" } })).toBe(false);
		expect(fs.existsSync(file)).toBe(false);
	});
	test("never throws when the directory is unwritable", () => {
		const blocker = path.join(dir, "blocker");
		fs.writeFileSync(blocker, "x");
		expect(() =>
			bootTrace("a", undefined, { file: path.join(blocker, "sub", "x.log") }),
		).not.toThrow();
		expect(bootTrace("a", undefined, { file: path.join(blocker, "sub", "x.log") })).toBe(false);
	});
	test("readBootTraceTail returns the last n lines, [] when missing", () => {
		for (let i = 0; i < 5; i++) bootTrace(`s${i}`, undefined, { file });
		const t = readBootTraceTail(2, file);
		expect(t).toHaveLength(2);
		expect(t[1]).toContain("s4");
		expect(readBootTraceTail(2, path.join(dir, "none"))).toEqual([]);
	});
});
