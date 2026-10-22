import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "..", "bin", "8gent.ts");
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "overlay-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(extra: Record<string, string>) {
	const env: Record<string, string | undefined> = {
		...process.env,
		EIGHT_HARNESS_DIR: dir,
		EIGHT_SESSION_ID: "s1",
		...extra,
	};
	if (!("EIGHT_PARENT_SESSION" in extra)) delete env.EIGHT_PARENT_SESSION;
	return Bun.spawnSync(
		[
			"bun",
			BIN,
			"overlay",
			"write",
			"cli1",
			JSON.stringify({
				guidance: { prompt_notes: ["note"], tool_hints: {} },
				expires_with: "task",
			}),
		],
		{ env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" },
	);
}

describe("8gent overlay write", () => {
	test("refuses with the tool-shell mark set and writes nothing", () => {
		const r = run({ EIGHT_PARENT_SESSION: "4242" });
		expect(r.exitCode).not.toBe(0);
		expect(existsSync(join(dir, "overlays", "cli1.json"))).toBe(false);
	});
	test("succeeds without the mark", () => {
		const r = run({});
		expect(r.stderr.toString()).not.toContain("refusing");
		expect(r.exitCode).toBe(0);
		expect(existsSync(join(dir, "overlays", "cli1.json"))).toBe(true);
	});
});
