/**
 * Instruction loader tests.
 *
 * Locks in the vendor-neutral priority order: AGENTS.md (open standard) is
 * canonical and wins over 8GENT.md and CLAUDE.md within a directory.
 *
 * HOME points at an empty temp dir for every test: the loader also merges
 * ~/.claude/CLAUDE.md and ~/.8gent/, so on any machine that has either file
 * the real home was a hidden input and "no instruction file" was not empty
 * (#2888, #3108). The loader reads $HOME for exactly this reason.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadInstructions } from "../instruction-loader";

let tmpRoot: string;
let tmpHome: string;
const realHome = process.env.HOME;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instr-"));
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instr-home-"));
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (realHome === undefined) Reflect.deleteProperty(process.env, "HOME");
	else process.env.HOME = realHome;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("loadInstructions priority", () => {
	it("loads AGENTS.md first, then the different files beside it (#259)", () => {
		fs.writeFileSync(path.join(tmpRoot, "AGENTS.md"), "from-agents");
		fs.writeFileSync(path.join(tmpRoot, "8GENT.md"), "from-8gent");
		fs.writeFileSync(path.join(tmpRoot, "CLAUDE.md"), "from-claude");

		const result = loadInstructions(tmpRoot);

		expect(result.indexOf("from-agents")).toBeGreaterThanOrEqual(0);
		expect(result.indexOf("from-8gent")).toBeGreaterThan(result.indexOf("from-agents"));
		expect(result.indexOf("from-claude")).toBeGreaterThan(result.indexOf("from-8gent"));
	});

	it("loads a symlinked or copied CLAUDE.md once", () => {
		fs.writeFileSync(path.join(tmpRoot, "AGENTS.md"), "one-rule-set");
		fs.symlinkSync(path.join(tmpRoot, "AGENTS.md"), path.join(tmpRoot, "CLAUDE.md"));
		fs.writeFileSync(path.join(tmpRoot, "8GENT.md"), "one-rule-set\n");

		expect(loadInstructions(tmpRoot).split("one-rule-set").length - 1).toBe(1);
	});

	it("an empty AGENTS.md does not hide the CLAUDE.md beside it", () => {
		fs.writeFileSync(path.join(tmpRoot, "AGENTS.md"), "\n");
		fs.writeFileSync(path.join(tmpRoot, "CLAUDE.md"), "from-claude");

		expect(loadInstructions(tmpRoot)).toContain("from-claude");
	});

	it("loads CLAUDE.md when it is the only file", () => {
		fs.writeFileSync(path.join(tmpRoot, "CLAUDE.md"), "from-claude");

		expect(loadInstructions(tmpRoot)).toContain("from-claude");
	});

	it("merges nested directories with closer files overriding farther ones", () => {
		const nested = path.join(tmpRoot, "pkg", "sub");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(tmpRoot, "AGENTS.md"), "root-rules");
		fs.writeFileSync(path.join(nested, "AGENTS.md"), "sub-rules");

		const result = loadInstructions(nested);

		expect(result).toContain("root-rules");
		expect(result).toContain("sub-rules");
		expect(result.indexOf("root-rules")).toBeLessThan(result.indexOf("sub-rules"));
	});

	it("returns an empty string when no instruction file is found", () => {
		expect(loadInstructions(tmpRoot)).toBe("");
	});
});
