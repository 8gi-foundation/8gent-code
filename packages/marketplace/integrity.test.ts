import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildIntegrity,
	computeRootHash,
	hashBuffer,
	verifyIntegrity,
	writeIntegrity,
} from "./integrity";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-integrity-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(root: string) {
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "manifest.json"), '{"name":"x"}');
	fs.writeFileSync(path.join(root, "SKILL.md"), "# x");
	fs.writeFileSync(path.join(root, "src/index.ts"), "export const x = 1;\n");
}

describe("computeRootHash", () => {
	it("is stable for the same input regardless of insertion order", () => {
		const a = computeRootHash({ a: "1", b: "2" });
		const b = computeRootHash({ b: "2", a: "1" });
		expect(a).toBe(b);
	});

	it("changes when content changes", () => {
		const before = computeRootHash({ a: hashBuffer("foo") });
		const after = computeRootHash({ a: hashBuffer("bar") });
		expect(before).not.toBe(after);
	});
});

describe("buildIntegrity / writeIntegrity / verifyIntegrity", () => {
	it("round-trips a clean directory", () => {
		seed(tmp);
		const integrity = writeIntegrity(tmp);
		expect(integrity.algorithm).toBe("sha256");
		expect(Object.keys(integrity.files)).toEqual(
			["SKILL.md", "manifest.json", "src/index.ts"],
		);
		const res = verifyIntegrity(tmp);
		expect(res.errors).toEqual([]);
		expect(res.ok).toBe(true);
	});

	it("flags a tampered file", () => {
		seed(tmp);
		writeIntegrity(tmp);
		fs.writeFileSync(path.join(tmp, "src/index.ts"), "tampered");
		const res = verifyIntegrity(tmp);
		expect(res.ok).toBe(false);
		expect(res.errors.join("\n")).toContain("hash mismatch");
	});

	it("flags an extra file added after build", () => {
		seed(tmp);
		writeIntegrity(tmp);
		fs.writeFileSync(path.join(tmp, "extra.txt"), "surprise");
		const res = verifyIntegrity(tmp);
		expect(res.ok).toBe(false);
		expect(res.errors.join("\n")).toContain("extra file");
	});

	it("flags a missing file", () => {
		seed(tmp);
		writeIntegrity(tmp);
		fs.rmSync(path.join(tmp, "src/index.ts"));
		const res = verifyIntegrity(tmp);
		expect(res.ok).toBe(false);
		expect(res.errors.join("\n")).toContain("declared file missing");
	});

	it("excludes INTEGRITY.json from its own hash list", () => {
		seed(tmp);
		const i = buildIntegrity(tmp);
		expect(i.files).not.toHaveProperty("INTEGRITY.json");
	});
});
