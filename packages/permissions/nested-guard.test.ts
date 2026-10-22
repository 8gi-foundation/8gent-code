/** #4715: an 8gent started inside an 8gent tool shell exits 2; outside one it starts. */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { NESTED_ENV, NESTED_MESSAGE, isNestedStart, toolShellEnv } from "./nested-guard";

const ENTRY = join(import.meta.dir, "..", "..", "bin", "8gent.ts");
const clean = (extra: Record<string, string> = {}) => {
	const env = { ...process.env, ...extra } as Record<string, string | undefined>;
	for (const k of [NESTED_ENV, "EIGHT_ALLOW_NESTED"]) if (!(k in extra)) delete env[k];
	return env as NodeJS.ProcessEnv;
};
const start = (env: NodeJS.ProcessEnv) =>
	spawnSync("bun", ["--no-env-file", ENTRY, "--version"], {
		env,
		encoding: "utf8",
		timeout: 60000,
	});

describe("nested start guard", () => {
	test("with the tool-shell mark set it refuses with exit 2", () => {
		const r = start(clean({ [NESTED_ENV]: "123" }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(NESTED_MESSAGE);
	});

	test("without the mark it starts", () => {
		expect(start(clean()).status).toBe(0);
	});

	test("EIGHT_ALLOW_NESTED=1 overrides", () => {
		expect(start(clean({ [NESTED_ENV]: "123", EIGHT_ALLOW_NESTED: "1" })).status).toBe(0);
	});

	test("toolShellEnv marks the child and keeps the rest", () => {
		const env = toolShellEnv({ A: "1" });
		expect(env.A).toBe("1");
		expect(isNestedStart(env)).toBe(true);
		expect(isNestedStart({ A: "1" })).toBe(false);
	});
});
