import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(import.meta.dir, "release-npm-guard.sh");
const run = (env: Record<string, string>) =>
	spawnSync("bash", [script, "0.20.42", "v0.20.42"], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});

describe("release-npm-guard", () => {
	test("version already on npm and no release here: fails loudly", () => {
		const r = run({ NPM_PUBLISHED_VERSION: "0.20.42", RELEASE_EXISTS: "0" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("already on npm");
	});
	test("version not on npm: passes", () => {
		expect(run({ NPM_PUBLISHED_VERSION: "", RELEASE_EXISTS: "0" }).status).toBe(0);
	});
	test("re-run of a release this repo started: passes", () => {
		expect(run({ NPM_PUBLISHED_VERSION: "0.20.42", RELEASE_EXISTS: "1" }).status).toBe(0);
	});
});
