/**
 * #3759: the native read_file resolves its path through safePath, like native
 * write_file and edit_file (#3747) and the text-tool read_file.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { CreatedFiles } from "../permissions/s1-created-files";

afterAll(cleanupTempDirs);

const priorContext = getToolContext();
afterEach(() => setToolContext(priorContext));

type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<string>;
const nativeRead = (args: Record<string, unknown>) =>
	(agentTools.read_file as unknown as { execute: Exec }).execute(args, { toolCallId: "t", messages: [] });

function setup(): { ws: string; outside: string } {
	const ws = tempDir("readconfine-ws-");
	const outside = tempDir("readconfine-out-");
	setToolContext({ ...priorContext, workingDirectory: ws, createdFiles: new CreatedFiles() });
	return { ws, outside };
}

describe("native read_file confinement (#3759)", () => {
	test("refuses an absolute path outside the root and reads nothing", async () => {
		const { outside } = setup();
		const target = path.join(outside, "secret.txt");
		fs.writeFileSync(target, "TOP-SECRET-CONTENT");
		const out = await nativeRead({ path: target });
		expect(out).toContain("outside");
		expect(out).toContain("Nothing was read");
		expect(out).not.toContain("TOP-SECRET-CONTENT");
	});

	test("refuses a relative path that climbs out of the root", async () => {
		const { ws } = setup();
		const name = `climbed-3759-${process.pid}.txt`;
		const sibling = path.join(ws, "..", name);
		fs.writeFileSync(sibling, "CLIMBED-CONTENT");
		try {
			const out = await nativeRead({ path: `../${name}` });
			expect(out).toContain("Nothing was read");
			expect(out).not.toContain("CLIMBED-CONTENT");
		} finally {
			fs.rmSync(sibling, { force: true });
		}
	});

	test("still reads a relative path inside the root", async () => {
		const { ws } = setup();
		fs.writeFileSync(path.join(ws, "a.txt"), "hello inside");
		expect(await nativeRead({ path: "a.txt" })).toBe("hello inside");
	});
});
