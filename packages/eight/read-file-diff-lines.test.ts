/**
 * read_file on a unified diff (review-two-findings pilot, runs 2026-10-06_185602
 * and 2026-10-08_234314): the #3375 gutter numbered the rows of the .diff file,
 * so a reviewer cited "test/store.test.ts:75" (a row of the diff; the file has 12
 * lines) and "store.ts:58". For a diff the gutter now carries the line number in
 * the patched file, which is the number a review cites.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const DIFF = [
	"diff --git a/src/store.ts b/src/store.ts",
	"index 1..2 100644",
	"--- a/src/store.ts",
	"+++ b/src/store.ts",
	"@@ -7,3 +7,4 @@ export function notesFor() {",
	" export function countNotes(a) {",
	"-\treturn a.length;",
	"+\tlet n = 0;",
	"+\treturn n;",
	" }",
	"@@ -20,2 +30,3 @@",
	" ctx",
	"+added late",
	" tail",
	"",
].join("\n");

let dir: string;
let executor: InstanceType<typeof ToolExecutor>;
const read = (args: Record<string, unknown>) =>
	executor.execute("read_file", args) as Promise<string>;

beforeEach(() => {
	dir = tempDir("read-file-diff-");
	executor = new ToolExecutor(dir);
	fs.mkdirSync(path.join(dir, "review"), { recursive: true });
	fs.writeFileSync(path.join(dir, "review/pr.diff"), DIFF);
	fs.writeFileSync(path.join(dir, "plain.txt"), "a\nb\n");
});

describe("read_file on a unified diff", () => {
	test("added and context rows carry their line number in the patched file", async () => {
		const rows = (await read({ path: "review/pr.diff" })).split("\n");
		const row = (text: string) => rows.find((r) => r.endsWith(`\t${text}`)) ?? "";
		expect(row("+\tlet n = 0;").trim()).toBe("8\t+\tlet n = 0;");
		expect(row("+\treturn n;").trim()).toBe("9\t+\treturn n;");
		expect(row(" export function countNotes(a) {").trim()).toBe("7\t export function countNotes(a) {");
		expect(row(" }").trim()).toBe("10\t }");
	});

	test("each hunk restarts at its own + start", async () => {
		const out = await read({ path: "review/pr.diff" });
		expect(out).toMatch(/ 31\t\+added late/);
		expect(out).toMatch(/ 32\t tail/);
	});

	test("headers and removed rows carry no number, so nothing can cite a diff row", async () => {
		const rows = (await read({ path: "review/pr.diff" })).split("\n");
		for (const text of ["+++ b/src/store.ts", "@@ -20,2 +30,3 @@", "-\treturn a.length;"]) {
			const r = rows.find((x) => x.endsWith(`\t${text}`)) ?? "";
			expect(r).not.toBe("");
			expect(r.split("\t")[0].trim()).toBe("");
		}
	});

	test("says what the numbers mean, once, before the diff", async () => {
		const out = await read({ path: "review/pr.diff" });
		expect(out.split("\n")[0]).toMatch(/patched file/);
		expect(out.match(/patched file/g)).toHaveLength(1);
	});

	test("other files keep the plain cat -n gutter", async () => {
		expect(await read({ path: "plain.txt" })).toBe("     1\ta\n     2\tb");
	});
});
