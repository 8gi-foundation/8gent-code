/**
 * `8gent doctor` must look where the real stores write (#3328):
 *   memory     -> ~/.8gent/memory/memory.db   (packages/memory/index.ts)
 *   profile    -> ~/.8gent/user.json          (packages/self-autonomy/onboarding.ts)
 *   settings   -> ~/.8gent/settings.json      (packages/settings/store.ts)
 * It drives the shipped CLI in a throwaway HOME, before and after the real
 * `onboard --yes` and `memory stats` commands, and checks doctor creates nothing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dir, "../../bin/8gent.ts");

function run(home: string, ...args: string[]): string {
	const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
	delete env.EIGHT_DATA_DIR;
	const r = Bun.spawnSync([process.execPath, CLI, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	// Strip ANSI so assertions read like the terminal does.
	return `${r.stdout.toString()}${r.stderr.toString()}`.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("8gent doctor paths (#3328)", () => {
	test("reports missing before onboarding and present after, without creating files", () => {
		const home = mkdtempSync(path.join(tmpdir(), "doctor-paths-"));
		try {
			const before = run(home, "doctor");
			expect(before).toContain("No memory DB yet");
			expect(before).toContain("No user profile yet");
			expect(before).toContain("No settings (using defaults)");
			expect(existsSync(path.join(home, ".8gent"))).toBe(false);

			run(home, "onboard", "--yes");
			run(home, "memory", "stats");
			writeFileSync(path.join(home, ".8gent", "settings.json"), "{}");
			expect(existsSync(path.join(home, ".8gent", "memory", "memory.db"))).toBe(true);
			expect(existsSync(path.join(home, ".8gent", "user.json"))).toBe(true);

			const after = run(home, "doctor");
			expect(after).toMatch(/Memory DB \(\d+ KB\)/);
			expect(after).toMatch(/User profile \(onboarding (complete|incomplete)\)/);
			expect(after).toContain("Settings valid");
			expect(after).not.toContain("No memory DB yet");
			expect(after).not.toContain("No user profile yet");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);
});
