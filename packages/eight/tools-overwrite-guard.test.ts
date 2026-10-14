/** #4238: write_file will not replace an existing file the model never read. */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { ToolExecutor } from "./tools";

afterAll(() => cleanupTempDirs());

function setup() {
	const root = tempDir("overwrite-guard-");
	const file = join(root, "count.ts");
	writeFileSync(file, "export const real = 6;\n");
	return { root, file, ex: new ToolExecutor(root) };
}

/** The run-014230 shape: a chained probe the sanitizer refuses. */
const probe = (ex: ToolExecutor) =>
	ex.execute("run_command", { command: 'ls count.ts 2>/dev/null; echo "exit:$?"' });

describe("write_file overwrite guard", () => {
	test("refuses to replace an unread existing file and leaves it intact", async () => {
		const { file, ex } = setup();
		expect(await probe(ex)).toStartWith("[BLOCKED]");
		const out = await ex.execute("write_file", { path: "count.ts", content: "mine\n" });
		expect(out).toStartWith("Error:");
		expect(out).toContain("read_file");
		expect(readFileSync(file, "utf-8")).toBe("export const real = 6;\n");
	});

	test("allows the overwrite after the file was read", async () => {
		const { file, ex } = setup();
		await probe(ex);
		await ex.execute("read_file", { path: "count.ts" });
		const out = await ex.execute("write_file", { path: "count.ts", content: "mine\n" });
		expect(out).not.toStartWith("Error:");
		expect(readFileSync(file, "utf-8")).toBe("mine\n");
	});

	test("without a refused command naming it, a plain overwrite is untouched", async () => {
		const { file, ex } = setup();
		await ex.execute("write_file", { path: "count.ts", content: "mine\n" });
		expect(readFileSync(file, "utf-8")).toBe("mine\n");
	});

	test("creates a new file, and may rewrite it later in the session", async () => {
		const { root, ex } = setup();
		const f = join(root, "new.ts");
		await ex.execute("write_file", { path: "new.ts", content: "a\n" });
		await ex.execute("write_file", { path: "new.ts", content: "b\n" });
		expect(readFileSync(f, "utf-8")).toBe("b\n");
	});

	test("identical content passes", async () => {
		const { ex } = setup();
		await probe(ex);
		const out = await ex.execute("write_file", {
			path: "count.ts",
			content: "export const real = 6;\n",
		});
		expect(out).not.toStartWith("Error:");
	});
});
