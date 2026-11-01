/**
 * `8gent doctor` must look where the real stores write (#3328):
 *   memory     -> ~/.8gent/memory/memory.db   (packages/memory/index.ts)
 *                 or $EIGHT_DATA_DIR/memory/memory.db when set
 *   profile    -> ~/.8gent/user.json          (packages/self-autonomy/onboarding.ts)
 *   settings   -> ~/.8gent/settings.json      (packages/settings/store.ts)
 * It drives the shipped CLI in a throwaway HOME, before and after the real
 * `onboard --yes` and `memory stats` commands, and checks doctor does not create
 * the memory, profile or settings files itself.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dir, "../../bin/8gent.ts");

function run(home: string, args: string[], extraEnv: Record<string, string> = {}): string {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		HOME: home,
		// resolveHome reads USERPROFILE first on Windows.
		USERPROFILE: home,
	};
	// The test preload sets EIGHT_HOME to the runner's own temp home, and
	// resolveHome() prefers it, so an inherited EIGHT_HOME would send doctor's
	// writes somewhere other than this throwaway HOME and hide them.
	delete env.EIGHT_DATA_DIR;
	delete env.EIGHT_HOME;
	Object.assign(env, extraEnv);
	const r = Bun.spawnSync([process.execPath, CLI, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	// Strip ANSI so assertions read like the terminal does.
	return `${r.stdout.toString()}${r.stderr.toString()}`.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("8gent doctor paths (#3328)", () => {
	test("reports missing before onboarding and present after, without creating those files", () => {
		const home = mkdtempSync(path.join(tmpdir(), "doctor-paths-"));
		const eight = path.join(home, ".8gent");
		try {
			const before = run(home, ["doctor"]);
			expect(before).toContain("No memory DB yet");
			expect(before).toContain("No user profile yet");
			expect(before).toContain("No settings (using defaults)");
			// Doctor must not create the three files it checks. It does still
			// create ~/.8gent/policy-checksum via the NemoClaw check
			// (packages/permissions/policy-engine.ts verifyChecksum); that write is
			// tracked separately in #3344, so the whole ~/.8gent dir is not asserted absent.
			expect(existsSync(path.join(eight, "memory", "memory.db"))).toBe(false);
			expect(existsSync(path.join(eight, "user.json"))).toBe(false);
			expect(existsSync(path.join(eight, "settings.json"))).toBe(false);

			run(home, ["onboard", "--yes"]);
			run(home, ["memory", "stats"]);
			writeFileSync(path.join(eight, "settings.json"), "{}");
			expect(existsSync(path.join(eight, "memory", "memory.db"))).toBe(true);
			expect(existsSync(path.join(eight, "user.json"))).toBe(true);

			const after = run(home, ["doctor"]);
			expect(after).toMatch(/Memory DB \(\d+ KB\)/);
			expect(after).toMatch(/User profile \(onboarding (complete|incomplete)\)/);
			expect(after).toContain("Settings valid");
			expect(after).not.toContain("No memory DB yet");
			expect(after).not.toContain("No user profile yet");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);

	test("reports the memory DB under $EIGHT_DATA_DIR/memory/memory.db when set", () => {
		const home = mkdtempSync(path.join(tmpdir(), "doctor-paths-home-"));
		const data = mkdtempSync(path.join(tmpdir(), "doctor-paths-data-"));
		try {
			// Without a DB under EIGHT_DATA_DIR, doctor reports none, even though
			// HOME has one: it must not fall back to ~/.8gent when EIGHT_DATA_DIR is set.
			mkdirSync(path.join(home, ".8gent", "memory"), { recursive: true });
			writeFileSync(path.join(home, ".8gent", "memory", "memory.db"), "");
			const missing = run(home, ["doctor"], { EIGHT_DATA_DIR: data });
			expect(missing).toContain("No memory DB yet");
			expect(existsSync(path.join(data, "memory", "memory.db"))).toBe(false);

			mkdirSync(path.join(data, "memory"), { recursive: true });
			writeFileSync(path.join(data, "memory", "memory.db"), Buffer.alloc(4096));
			const present = run(home, ["doctor"], { EIGHT_DATA_DIR: data });
			expect(present).toContain("Memory DB (4 KB)");
			expect(present).not.toContain("No memory DB yet");
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(data, { recursive: true, force: true });
		}
	}, 60_000);
});
