import { afterEach, describe, expect, test } from "bun:test";
import { commandWritesStartupCode, validatePath } from "./path-guard";
import { buildRunCommandProfile, protectedRunCommandPaths } from "./run-command-sandbox";

const saved = process.env.EIGHT_DATA_DIR;
afterEach(() => {
	if (saved === undefined) process.env.EIGHT_DATA_DIR = undefined;
	else process.env.EIGHT_DATA_DIR = saved;
	if (saved === undefined) delete process.env.EIGHT_DATA_DIR;
});

const HOME = "/Users/someone";
const WRITE = `echo '{"choice":"yes"}' > ~/.8gent/yolo.json`;

describe("yolo.json is not for tools to write", () => {
	test("validatePath refuses write and read under the home dir", () => {
		const p = `${HOME}/.8gent/yolo.json`;
		expect(validatePath(p, `${HOME}/proj`, { home: HOME }, "write").ok).toBe(false);
		expect(validatePath("~/.8gent/yolo.json", `${HOME}/proj`, { home: HOME }, "write").ok).toBe(
			false,
		);
		expect(validatePath(p, `${HOME}/proj`, { home: HOME }, "read").ok).toBe(false);
	});

	test("validatePath refuses a write under EIGHT_DATA_DIR", () => {
		process.env.EIGHT_DATA_DIR = `${HOME}/elsewhere`;
		expect(
			validatePath(`${HOME}/elsewhere/yolo.json`, `${HOME}/proj`, { home: HOME }, "write").ok,
		).toBe(false);
	});

	test("a shell command that writes it is caught, home and data-dir forms", () => {
		expect(commandWritesStartupCode(WRITE, `${HOME}/proj`, { home: HOME })).toBe(true);
		expect(
			commandWritesStartupCode(`echo yes > ${HOME}/.8gent/yolo.json`, `${HOME}/proj`, {
				home: HOME,
			}),
		).toBe(true);
		process.env.EIGHT_DATA_DIR = `${HOME}/elsewhere`;
		expect(
			commandWritesStartupCode(`echo yes > ${HOME}/elsewhere/yolo.json`, `${HOME}/proj`, {
				home: HOME,
			}),
		).toBe(true);
		expect(commandWritesStartupCode("echo hi > notes.txt", `${HOME}/proj`, { home: HOME })).toBe(
			false,
		);
	});

	test("the sandbox protects it under the home and the data dir", () => {
		process.env.EIGHT_DATA_DIR = "/data/eight";
		const paths = protectedRunCommandPaths();
		expect(paths.files.some((f) => f.endsWith("/.8gent/yolo.json"))).toBe(true);
		expect(paths.files).toContain("/data/eight/yolo.json");
		expect(buildRunCommandProfile(paths)).toContain("/data/eight/yolo.json");
	});
});
