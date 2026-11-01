/**
 * `8gent onboard --yes` must persist onboarding as complete (#3329).
 *
 * Drives the shipped CLI in a throwaway HOME, then reads ~/.8gent/user.json
 * off disk and checks the readers (`preferences get`, `status --json`) agree.
 * Before the fix, bin/8gent.ts set onboardingComplete on the shallow copy
 * returned by getUser(), so the flag never reached disk.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dir, "../../bin/8gent.ts");

function run(home: string, args: string[]): string {
	const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
	// The test preload points EIGHT_HOME at the runner's own temp home; clear it
	// and EIGHT_DATA_DIR so the child resolves everything under this HOME.
	delete env.EIGHT_DATA_DIR;
	delete env.EIGHT_HOME;
	const r = Bun.spawnSync([process.execPath, CLI, ...args], {
		cwd: home,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return `${r.stdout.toString()}${r.stderr.toString()}`.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("8gent onboard --yes (#3329)", () => {
	test("persists onboardingComplete with sensible defaults", () => {
		const home = mkdtempSync(path.join(tmpdir(), "onboard-yes-"));
		try {
			const out = run(home, ["onboard", "--yes"]);
			expect(out).not.toContain("Run with --yes");

			const user = JSON.parse(readFileSync(path.join(home, ".8gent", "user.json"), "utf-8"));
			expect(user.onboardingComplete).toBe(true);
			expect(user.identity.communicationStyle).toBe("concise");
			expect(typeof user.identity.language).toBe("string");
			expect(user.understanding.confidenceScore).toBeGreaterThanOrEqual(0);

			expect(run(home, ["preferences", "get"])).toContain("Onboarded: yes");

			const status = run(home, ["status", "--json"]);
			const json = JSON.parse(status.slice(status.indexOf("{")));
			expect(json.user.onboarded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);
});
