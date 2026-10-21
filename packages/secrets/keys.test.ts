import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeysIntoEnv } from "./keys";

const NAMES = [
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"EIGHT_TERMUX_LD_PRELOAD",
	"EIGHT_TERMUX_KEEP_PRELOAD",
	"TERMUX_EXEC__PROC_SELF_EXE",
	"KEYS_TEST_4683_API_KEY",
];
const saved = new Map(NAMES.map((n) => [n, process.env[n]]));
const dirs: string[] = [];
afterEach(() => {
	for (const [n, v] of saved) {
		if (v === undefined) delete process.env[n];
		else process.env[n] = v;
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadKeysIntoEnv", () => {
	test("loader and Termux exec names in a keys file are ignored; API keys load", () => {
		for (const n of NAMES) delete process.env[n];
		const dir = mkdtempSync(join(tmpdir(), "keys-"));
		dirs.push(dir);
		const file = join(dir, "keys.env");
		writeFileSync(
			file,
			[
				"LD_PRELOAD=/tmp/evil.so",
				"ld_library_path=/tmp",
				"DYLD_INSERT_LIBRARIES=/tmp/evil.dylib",
				"EIGHT_TERMUX_LD_PRELOAD=/tmp/evil.so",
				"EIGHT_TERMUX_KEEP_PRELOAD=1",
				"TERMUX_EXEC__PROC_SELF_EXE=/tmp/evil-node",
				"KEYS_TEST_4683_API_KEY=ok",
				"",
			].join("\n"),
		);
		expect(loadKeysIntoEnv(file)).toBe(1);
		expect(process.env.KEYS_TEST_4683_API_KEY).toBe("ok");
		for (const n of NAMES.slice(0, -1)) expect(process.env[n]).toBeUndefined();
		expect(process.env.ld_library_path).toBeUndefined();
	});
});
