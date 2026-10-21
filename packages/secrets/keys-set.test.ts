import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeyInFile } from "./keys";

describe("setKeyInFile", () => {
	const f = () => join(mkdtempSync(join(tmpdir(), "keys-")), "keys.env");
	test("rejects a short value and writes nothing", () => {
		const p = f();
		expect(setKeyInFile("MINIMAX_API_KEY", "Z", p)).toContain("too short");
		expect(() => readFileSync(p)).toThrow();
	});
	test("writes 0600, replaces an earlier line, keeps others", () => {
		const p = f();
		writeFileSync(p, "OTHER=keepme\nMINIMAX_API_KEY=Z\n");
		expect(setKeyInFile("MINIMAX_API_KEY", "fake-key-0123456789abcd", p)).toBeNull();
		expect(readFileSync(p, "utf-8")).toBe("OTHER=keepme\nMINIMAX_API_KEY=fake-key-0123456789abcd\n");
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});
});
