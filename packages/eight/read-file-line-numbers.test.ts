/**
 * #3375: read_file returned raw text with no line numbers, so a model asked
 * "which line" had to count by hand and got it wrong (l5-locate pilot runs
 * 2026-10-03_004939, _012538, _064746: read src/config/load.ts, cited line 19,
 * the answer was 16). read_file now numbers every line the way `cat -n` does,
 * offset/limit keep the file's true line numbers, and the two places that
 * consume read_file output keep working:
 *
 * - edit_file still matches the text on disk. A model that pastes the number
 *   prefix into oldText gets an error that names the prefix, not a bare
 *   "could not find".
 * - extractAutoMemories (packages/memory) still records package.json and
 *   README facts from the numbered output.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { extractAutoMemories } from "../memory";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

let dir: string;
let executor: InstanceType<typeof ToolExecutor>;

const read = (args: Record<string, unknown>) =>
	executor.execute("read_file", args) as Promise<string>;

beforeEach(() => {
	dir = tempDir("read-file-lines-");
	executor = new ToolExecutor(dir);
});

/** The l5-locate fixture shape: the answer sits on line 16. */
function writeLoadTs(): string {
	const lines = Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`);
	lines[15] = "export const DEFAULT_TIMEOUT_MS = 5000;";
	fs.mkdirSync(path.join(dir, "src/config"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src/config/load.ts"), `${lines.join("\n")}\n`);
	return "src/config/load.ts";
}

describe("read_file numbers lines (#3375)", () => {
	test("every line carries its 1-based number in a cat -n gutter", async () => {
		const file = writeLoadTs();
		const out = await read({ path: file });
		const outLines = out.split("\n");
		expect(outLines).toHaveLength(30); // trailing newline is not a 31st line
		expect(outLines[0]).toBe("     1\t// line 1");
		expect(outLines[15]).toBe("    16\texport const DEFAULT_TIMEOUT_MS = 5000;");
		expect(outLines[29]).toBe("    30\t// line 30");
	});

	test("empty lines are numbered too, so the count never drifts", async () => {
		fs.writeFileSync(path.join(dir, "gaps.txt"), "a\n\nb\n");
		expect(await read({ path: "gaps.txt" })).toBe("     1\ta\n     2\t\n     3\tb");
	});

	test("offset and limit keep the file's true line numbers", async () => {
		const file = writeLoadTs();
		const out = await read({ path: file, offset: 15, limit: 3 });
		const numbered = out.split("\n").filter((l) => /^ *\d+\t/.test(l));
		expect(numbered).toEqual([
			"    15\t// line 15",
			"    16\texport const DEFAULT_TIMEOUT_MS = 5000;",
			"    17\t// line 17",
		]);
		// It says there is more and where to continue from.
		expect(out).toContain("offset=18");
	});

	test("offset alone reads to the end of the file", async () => {
		const file = writeLoadTs();
		const out = await read({ path: file, offset: 29 });
		expect(out).toBe("    29\t// line 29\n    30\t// line 30");
	});

	test("an offset past the end says so instead of returning nothing", async () => {
		const file = writeLoadTs();
		const out = await read({ path: file, offset: 99 });
		expect(out).toContain("30 lines");
		expect(out).not.toMatch(/^ *\d+\t/m);
	});

	test("a long code file is truncated with true numbers, and offset reads past line 200", async () => {
		const lines = Array.from({ length: 250 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
		fs.writeFileSync(path.join(dir, "big.ts"), `${lines.join("\n")}\n`);
		const head = await read({ path: "big.ts" });
		expect(head).toContain("     1\texport const v1 = 1;");
		expect(head).toContain("   200\texport const v200 = 200;");
		expect(head).not.toContain("v201 ");
		const tail = await read({ path: "big.ts", offset: 240 });
		expect(tail).toContain("   240\texport const v240 = 240;");
		expect(tail).toContain("   250\texport const v250 = 250;");
	});
});

describe("edit_file after a numbered read_file (#3375)", () => {
	test("oldText copied from the file text (no gutter) still edits", async () => {
		const file = writeLoadTs();
		const out = await executor.execute("edit_file", {
			path: file,
			oldText: "export const DEFAULT_TIMEOUT_MS = 5000;",
			newText: "export const DEFAULT_TIMEOUT_MS = 8000;",
		});
		expect(out).toContain("File edited");
		const disk = fs.readFileSync(path.join(dir, file), "utf-8");
		expect(disk.split("\n")[15]).toBe("export const DEFAULT_TIMEOUT_MS = 8000;");
		expect(disk).not.toMatch(/^ *\d+\t/m); // no gutter ever reaches the file
	});

	test("oldText pasted with the number prefix gets an error naming the prefix, and the file is untouched", async () => {
		const file = writeLoadTs();
		const before = fs.readFileSync(path.join(dir, file), "utf-8");
		const out = (await executor.execute("edit_file", {
			path: file,
			oldText: "    16\texport const DEFAULT_TIMEOUT_MS = 5000;\n    17\t// line 17",
			newText: "export const DEFAULT_TIMEOUT_MS = 8000;\n// line 17",
		})) as string;
		expect(out).toStartWith("Error:");
		expect(out).toContain("line-number prefix");
		expect(fs.readFileSync(path.join(dir, file), "utf-8")).toBe(before);
	});

	test("a plain miss keeps the plain error", async () => {
		const file = writeLoadTs();
		const out = (await executor.execute("edit_file", {
			path: file,
			oldText: "not in the file",
			newText: "x",
		})) as string;
		expect(out).toContain("Could not find the text");
		expect(out).not.toContain("line-number prefix");
	});
});

describe("extractAutoMemories reads numbered read_file output (#3375)", () => {
	test("package.json facts survive the line numbers", async () => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify(
				{
					name: "demo-app",
					description: "A demo app",
					dependencies: { react: "^19.0.0" },
					devDependencies: { typescript: "^5.0.0" },
				},
				null,
				2,
			),
		);
		const out = await read({ path: "package.json" });
		expect(out).toMatch(/^ +1\t\{/); // the real path is numbered
		const facts = extractAutoMemories("read_file", { path: "package.json" }, out).map(
			(f) => f.fact,
		);
		expect(facts).toContain("Project name: demo-app");
		expect(facts).toContain("Project description: A demo app");
		expect(facts).toContain("Tech stack includes: react, typescript");
	});

	test("README purpose is the sentence, not the gutter", async () => {
		fs.writeFileSync(
			path.join(dir, "README.md"),
			"# Demo\n\nDemo app that turns invoices into tidy ledgers.\n",
		);
		const out = await read({ path: "README.md" });
		const facts = extractAutoMemories("read_file", { path: "README.md" }, out).map((f) => f.fact);
		expect(facts).toEqual(["Project purpose: Demo app that turns invoices into tidy ledgers."]);
	});

	test("raw (unnumbered) results still parse, for any caller passing file text", () => {
		const facts = extractAutoMemories(
			"read_file",
			{ path: "package.json" },
			'{"name":"raw-app"}',
		).map((f) => f.fact);
		expect(facts).toContain("Project name: raw-app");
	});
});
