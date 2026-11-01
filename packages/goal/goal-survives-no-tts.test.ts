/**
 * #4721: /goal on a phone exited the whole TUI because goal completion spawned
 * a private TTS path with no error handler. HOME is an empty temp dir and PATH
 * holds no TTS binary; the run completes and the process must still be alive.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function runFixture(extraEnv: Record<string, string>) {
	const home = mkdtempSync(join(tmpdir(), "goal-home-"));
	const empty = mkdtempSync(join(tmpdir(), "goal-path-"));
	dirs.push(home, empty);
	const fixture = join(import.meta.dir, "survive-fixture.ts");
	return Bun.spawnSync([process.execPath, fixture], {
		env: { HOME: home, PATH: empty, TMPDIR: tmpdir(), ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("goal run on a machine with no TTS", () => {
	test("audio off (default): completes, process alive, exit 0", () => {
		const r = runFixture({});
		expect(r.stderr.toString()).not.toContain("ENOENT");
		expect(r.stdout.toString()).toContain("ALIVE status=completed");
		expect(r.exitCode).toBe(0);
	});

	test("audio allowed (EIGHT_VOICE=1) but no engine installed: silent, alive, exit 0", () => {
		const r = runFixture({ EIGHT_VOICE: "1" });
		expect(r.stderr.toString()).not.toContain("ENOENT");
		expect(r.stdout.toString()).toContain("ALIVE status=completed");
		expect(r.exitCode).toBe(0);
	});
});
