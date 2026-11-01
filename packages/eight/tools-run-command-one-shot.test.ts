/**
 * The local 27B model reads only the first sentence of a tool description. It sent
 * run_command with commands joined by ; or && (practice runs 2026-10-20_112132 and
 * _120657) and never ran its tests. The first sentence must carry the one-command rule.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "./tools";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-cmd-one-shot-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("run_command description", () => {
	test("the first sentence says one command per call and names the chaining forms", () => {
		const defs = new ToolExecutor(dir, "one-shot-test").getToolDefinitions() as Array<{
			function: { name: string; description: string };
		}>;
		const desc = defs.find((d) => d.function.name === "run_command")?.function.description ?? "";
		const first = desc.split(/\.\s/)[0] ?? "";
		expect(first).toContain("ONE command per call");
		for (const op of [";", "&&", "||", "newline"]) expect(first).toContain(op);
		expect(first).toContain("its own run_command call");
	});
});
