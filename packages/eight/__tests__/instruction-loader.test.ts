/**
 * Instruction loader tests.
 *
 * Locks in the vendor-neutral priority order: AGENTS.md (open standard) is
 * canonical and wins over 8GENT.md and CLAUDE.md within a directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadInstructions } from "../instruction-loader";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instr-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadInstructions priority", () => {
	it("prefers AGENTS.md over 8GENT.md and CLAUDE.md in a directory", () => {
		fs.writeFileSync(path.join(tmpRoot, "AGENTS.md"), "from-agents");
		fs.writeFileSync(path.join(tmpRoot, "8GENT.md"), "from-8gent");
		fs.writeFileSync(path.join(tmpRoot, "CLAUDE.md"), "from-claude");

		const result = loadInstructions(tmpRoot);

		expect(result).toContain("from-agents");
		expect(result).not.toContain("from-8gent");
		expect(result).not.toContain("from-claude");
	});

	it("prefers 8GENT.md over CLAUDE.md when no AGENTS.md is present", () => {
		fs.writeFileSync(path.join(tmpRoot, "8GENT.md"), "from-8gent");
		fs.writeFileSync(path.join(tmpRoot, "CLAUDE.md"), "from-claude");

		const result = loadInstructions(tmpRoot);

		expect(result).toContain("from-8gent");
		expect(result).not.toContain("from-claude");
	});

	it("falls back to CLAUDE.md only when no vendor-neutral file exists", () => {
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
